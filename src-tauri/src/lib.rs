use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use btleplug::api::{
    Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use chrono::{Local, NaiveDate, NaiveDateTime, TimeDelta, Timelike};
use futures::StreamExt;
use openwhoop::{OpenWhoop, WhoopDevice};
use openwhoop_algos::{
    RecoveryBand, RecoveryDriver, RecoveryNight, SleepConsistencyAnalyzer, SleepCycle,
    age_normed_hrv_score, compute_recovery,
};
use openwhoop_codec::{
    WhoopData, WhoopPacket,
    constants::{
        CMD_TO_STRAP_GEN4 as CMD_TO_STRAP, CommandNumber,
        DATA_FROM_STRAP_GEN4 as DATA_FROM_STRAP, PacketType,
        WHOOP_SERVICE_GEN4 as WHOOP_SERVICE, WhoopGeneration,
    },
};
use openwhoop_db::DatabaseHandler;
use openwhoop_entities::{battery_log, heart_rate, sleep_cycles};
use openwhoop_types::activities::{ActivityPeriod, ActivityType, SearchActivityPeriods};
use sea_orm::{
    ActiveValue::NotSet, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager as _, State, Wry,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tokio::sync::{Mutex, Notify, RwLock};

// ---------------------------------------------------------------- config

#[derive(Serialize, Deserialize, Default, Clone)]
struct Config {
    device_name: Option<String>,
    /// Minutes between automatic syncs. None or 0 = manual only.
    #[serde(default)]
    sync_interval_minutes: Option<u32>,
    /// Minutes between presence scans. None = default (2), Some(0) = off.
    #[serde(default)]
    presence_interval_minutes: Option<u32>,
    /// Date of birth — used to age-norm the HRV ring against published
    /// population HRV distributions. Optional: without a DOB the HRV
    /// ring falls back to just the raw ms value with no 0–100 score.
    #[serde(default)]
    dob: Option<NaiveDate>,
    /// When true, recent sleep *surplus* (slept more than need)
    /// reduces tonight's sleep need (Rupp 2009 "banking"). WHOOP's
    /// user-facing number doesn't do this, so the default is off.
    /// See docs/SLEEP_STAGING.md for the science.
    #[serde(default)]
    allow_surplus_banking: bool,
}

/// Returns Some(minutes) if presence scans are enabled, None if disabled.
fn effective_presence_minutes(cfg: &Config) -> Option<u32> {
    match cfg.presence_interval_minutes {
        None => Some(2),
        Some(0) => None,
        Some(n) => Some(n),
    }
}

impl Config {
    fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, path: &PathBuf) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

// ---------------------------------------------------------------- state

struct AppState {
    db: RwLock<Option<Arc<DatabaseHandler>>>,
    db_path: RwLock<Option<String>>,
    config: RwLock<Config>,
    config_path: RwLock<Option<PathBuf>>,
    battery: RwLock<Option<BatteryInfo>>,
    sync_in_progress: RwLock<bool>,
    last_sync_at: RwLock<Option<NaiveDateTime>>,
    last_sync_attempt_at: RwLock<Option<NaiveDateTime>>,
    next_sync_at: RwLock<Option<NaiveDateTime>>,
    scheduler_notify: Arc<Notify>,
    presence_notify: Arc<Notify>,
    sync_cancel: Arc<AtomicBool>,
    sync_cancel_reason: Arc<RwLock<Option<CancelReason>>>,
    strap_seen_at: RwLock<Option<NaiveDateTime>>,
    ble_lock: Arc<Mutex<()>>,
    alarm: RwLock<Option<AlarmStatus>>,
    live_active: Arc<AtomicBool>,
    live_cancel: Arc<Notify>,
}

#[derive(Serialize, Clone, Copy)]
struct BatteryInfo {
    percent: f32,
    charging: bool,
    is_worn: bool,
    updated_at: NaiveDateTime,
}

#[derive(Serialize, Clone, Copy)]
struct BatteryEstimate {
    hours_remaining: f64,
    drain_rate_pct_per_hour: f64,
    data_points: usize,
    confidence: &'static str,
}

#[derive(Clone, Copy, Debug)]
enum CancelReason {
    User,
    HardTimeout,
    NoProgress,
}

#[derive(Serialize, Clone, Copy)]
struct AlarmStatus {
    enabled: bool,
    /// Local-time alarm timestamp. None when disabled.
    at: Option<NaiveDateTime>,
}

// ---------------------------------------------------------------- snapshot types

#[derive(Serialize, Clone)]
struct Snapshot {
    generated_at: NaiveDateTime,
    today: TodaySection,
    latest_sleep: Option<SleepSection>,
    recovery: Option<RecoverySection>,
    week: WeekSection,
    recent_activities: Vec<ActivitySummary>,
    battery: Option<BatteryInfo>,
    last_sync_at: Option<NaiveDateTime>,
    last_sync_attempt_at: Option<NaiveDateTime>,
    next_sync_at: Option<NaiveDateTime>,
    sync_in_progress: bool,
    strap_seen_at: Option<NaiveDateTime>,
    alarm: Option<AlarmStatus>,
    battery_estimate: Option<BatteryEstimate>,
}

#[derive(Serialize, Clone)]
struct RecoverySection {
    score: f64,
    /// "red" | "yellow" | "green"
    band: &'static str,
    /// "hrv" | "rhr" | "sleep" | "rr" | "skin_temp" | "none"
    dominant_driver: &'static str,
    /// Which night this recovery was computed for (the wake date).
    for_sleep_id: NaiveDate,
    /// How many prior nights contributed to the baseline (≤14).
    baseline_window_nights: usize,
    calibrating: bool,
    /// Per-metric z-scores (positive = better for recovery). Useful for
    /// debugging and for a future drill-in view.
    z_hrv: Option<f64>,
    z_rhr: Option<f64>,
    z_sleep: Option<f64>,
    z_rr: Option<f64>,
    z_skin_temp: Option<f64>,
    /// Raw RMSSD (ms) from this night — surfaced so the HRV ring can
    /// show the underlying number alongside the age-normed score.
    hrv_rmssd_ms: Option<f64>,
    /// HRV score against age-matched population norms (0–100). `None`
    /// when no DOB is configured — the HRV ring then falls back to
    /// displaying just the raw ms.
    age_normed_hrv_score: Option<f64>,
}

#[derive(Serialize, Clone)]
struct DiscoveredDevice {
    name: String,
    rssi: Option<i16>,
}

#[derive(Serialize, Clone)]
struct TodaySection {
    sample_count: usize,
    last_seen: Option<NaiveDateTime>,
    current_bpm: Option<u8>,
    min_bpm: Option<u8>,
    avg_bpm: Option<u8>,
    max_bpm: Option<u8>,
    latest_stress: Option<f64>,
    latest_spo2: Option<f64>,
    latest_skin_temp: Option<f64>,
    hourly_bpm: [Option<u16>; 24],
    /// Lightweight (time, bpm) series for the last 24h so the frontend can
    /// re-bin at any time scale without round-tripping.
    hr_series: Vec<HrPoint>,
}

#[derive(Serialize, Clone)]
struct HrPoint {
    t: NaiveDateTime,
    b: u8,
}

#[derive(Serialize, Clone)]
struct SleepSection {
    night: String,
    start: NaiveDateTime,
    end: NaiveDateTime,
    duration_minutes: i64,
    score: f64,
    min_bpm: u8,
    avg_bpm: u8,
    max_bpm: u8,
    min_hrv: u16,
    avg_hrv: u16,
    max_hrv: u16,
}

#[derive(Serialize, Clone)]
struct WeekSection {
    sleep_nights: usize,
    avg_sleep_duration_minutes: Option<i64>,
    avg_sleep_score: Option<f64>,
    consistency_score: Option<f64>,
    workout_count: usize,
    workout_total_minutes: i64,
}

#[derive(Serialize, Clone)]
struct ActivitySummary {
    kind: String,
    start: NaiveDateTime,
    end: NaiveDateTime,
    duration_minutes: i64,
}

#[derive(Serialize, Clone)]
struct SyncReport {
    duration_secs: f64,
    new_readings: usize,
    total_readings: usize,
    sleep_nights: usize,
    activities: usize,
    battery: Option<BatteryInfo>,
}

// ---------------------------------------------------------------- helpers

async fn ensure_db(state: &State<'_, AppState>) -> Result<Arc<DatabaseHandler>, String> {
    if let Some(db) = state.db.read().await.clone() {
        return Ok(db);
    }
    let path = state
        .db_path
        .read()
        .await
        .clone()
        .ok_or_else(|| "db path not configured".to_string())?;
    let handler = Arc::new(DatabaseHandler::new(path).await);
    *state.db.write().await = Some(handler.clone());
    Ok(handler)
}

async fn ensure_db_from_handle(app: &AppHandle) -> Result<Arc<DatabaseHandler>, String> {
    let state = app.state::<AppState>();
    ensure_db(&state).await
}

// ---------------------------------------------------------------- commands

#[tauri::command]
async fn get_snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let db = ensure_db(&state).await?;
    let battery = *state.battery.read().await;
    let last_sync_at = *state.last_sync_at.read().await;
    let last_sync_attempt_at = *state.last_sync_attempt_at.read().await;
    let next_sync_at = *state.next_sync_at.read().await;
    let sync_in_progress = *state.sync_in_progress.read().await;
    let strap_seen_at = *state.strap_seen_at.read().await;
    let alarm = *state.alarm.read().await;
    let battery_estimate = match battery {
        Some(b) if !b.charging => estimate_battery_remaining(&db, b.percent).await,
        _ => None,
    };
    let age_years = {
        let cfg = state.config.read().await;
        cfg.dob
            .and_then(|d| Local::now().naive_local().date().years_since(d))
    };
    build_snapshot(
        &db,
        battery,
        last_sync_at,
        last_sync_attempt_at,
        next_sync_at,
        sync_in_progress,
        strap_seen_at,
        alarm,
        battery_estimate,
        age_years,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_sync(state: State<'_, AppState>) -> Result<(), String> {
    *state.sync_cancel_reason.write().await = Some(CancelReason::User);
    state.sync_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn get_alarm(app: AppHandle) -> Result<AlarmStatus, String> {
    do_alarm_op(app, AlarmOp::Read).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_alarm(app: AppHandle, unix: i64) -> Result<AlarmStatus, String> {
    let unix = u32::try_from(unix).map_err(|_| "alarm timestamp out of range".to_string())?;
    do_alarm_op(app, AlarmOp::Set(unix)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_alarm(app: AppHandle) -> Result<AlarmStatus, String> {
    do_alarm_op(app, AlarmOp::Clear).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ring_strap(app: AppHandle) -> Result<(), String> {
    do_ring_strap(app).await.map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
struct LiveSample {
    bpm: u8,
    raw_hex: String,
    ts: NaiveDateTime,
}

#[tauri::command]
async fn start_live_stream(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.live_active.load(Ordering::SeqCst) {
        return Err("Live stream already running".into());
    }
    if *state.sync_in_progress.read().await {
        return Err("Sync in progress — try again in a moment".into());
    }
    if state.config.read().await.device_name.is_none() {
        return Err("Set a device name first.".into());
    }

    state.live_active.store(true, Ordering::SeqCst);
    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_live_stream(app_task.clone()).await;
        let state = app_task.state::<AppState>();
        state.live_active.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                let _ = app_task.emit("live:stopped", ());
            }
            Err(e) => {
                let _ = app_task.emit("live:error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn stop_live_stream(state: State<'_, AppState>) -> Result<(), String> {
    state.live_cancel.notify_waiters();
    Ok(())
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn whoop_char(uuid: uuid::Uuid) -> Characteristic {
    Characteristic {
        uuid,
        service_uuid: WHOOP_SERVICE,
        properties: CharPropFlags::empty(),
        descriptors: BTreeSet::new(),
    }
}

async fn run_live_stream(app: AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let device_name = state
        .config
        .read()
        .await
        .device_name
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Device not configured"))?;
    let cancel = state.live_cancel.clone();

    let _ble_guard = state.ble_lock.clone().lock_owned().await;
    let _ = app.emit("live:starting", ());

    let manager = Manager::new().await?;
    let adapter = manager
        .adapters()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No Bluetooth adapter found"))?;

    let peripheral = scan_for_device(&adapter, &device_name).await?;
    peripheral.connect().await?;
    let _ = adapter.stop_scan().await;
    peripheral.discover_services().await?;

    let data_char = whoop_char(DATA_FROM_STRAP);
    let cmd_char = whoop_char(CMD_TO_STRAP);

    peripheral.subscribe(&data_char).await?;

    let enable = WhoopPacket::new(
        PacketType::Command,
        0,
        CommandNumber::ToggleRealtimeHr.as_u8(),
        vec![0x01],
    )
    .framed_packet()?;
    peripheral
        .write(&cmd_char, &enable, WriteType::WithoutResponse)
        .await?;

    let mut notifications = peripheral.notifications().await?;

    *state.strap_seen_at.write().await = Some(Local::now().naive_local());
    let _ = app.emit("live:started", ());

    let stream_result: anyhow::Result<()> = async {
        loop {
            tokio::select! {
                _ = cancel.notified() => break,
                notif = notifications.next() => {
                    let Some(notif) = notif else { break };
                    if notif.uuid != DATA_FROM_STRAP { continue; }
                    let raw = notif.value.clone();
                    let Ok(packet) = WhoopPacket::from_data(notif.value) else { continue; };
                    if packet.packet_type != PacketType::RealtimeData { continue; }
                    if packet.data.len() < 6 { continue; }
                    let bpm = packet.data[5];
                    let sample = LiveSample {
                        bpm,
                        raw_hex: bytes_to_hex(&raw),
                        ts: Local::now().naive_local(),
                    };
                    let _ = app.emit("live_sample", sample);
                }
            }
        }
        Ok(())
    }
    .await;

    // Best-effort: disable the stream and disconnect so we don't leave the
    // strap transmitting in the background.
    if let Ok(disable) = WhoopPacket::new(
        PacketType::Command,
        0,
        CommandNumber::ToggleRealtimeHr.as_u8(),
        vec![0x00],
    )
    .framed_packet()
    {
        let _ = peripheral
            .write(&cmd_char, &disable, WriteType::WithoutResponse)
            .await;
    }
    let _ = peripheral.disconnect().await;

    stream_result
}

/// Return the full sleep-staging snapshot for the most recent cycle.
/// `None` when no sleep has been detected + staged yet.
///
/// This is the Phase-1 data source for the hypnogram / stage-breakdown /
/// score-component UI in the Latest Sleep card. The snapshot is
/// re-computed on every call (it reads the cycle + epochs from SQLite
/// and quantizes the hypnogram to 1-minute resolution); for a typical
/// 960-epoch night it's sub-millisecond.
#[tauri::command]
async fn get_sleep_snapshot(
    state: State<'_, AppState>,
) -> Result<Option<openwhoop::sleep_staging::SleepSnapshot>, String> {
    let db = ensure_db(&state).await?;
    openwhoop::sleep_staging::latest_sleep_snapshot(&db)
        .await
        .map_err(|e| e.to_string())
}

/// Phase-2 Today card: today's wear time, HRV, activity breakdown,
/// events, device info, alarms, and sync log as a single payload.
/// Fail-soft per source — a query failure substitutes empty/None
/// rather than short-circuiting the whole snapshot.
#[tauri::command]
async fn get_daily_snapshot(
    state: State<'_, AppState>,
) -> Result<openwhoop::daily_snapshot::DailySnapshot, String> {
    let db = ensure_db(&state).await?;
    openwhoop::daily_snapshot::get_daily_snapshot(&db)
        .await
        .map_err(|e| e.to_string())
}

/// Phase-3.1 History page: 14-night rollup of sleep cycles + per-day
/// wear / daytime HRV / activity breakdown. Days argument is clamped
/// server-side; UI always asks for the default 14-day window today.
#[tauri::command]
async fn get_sleep_history(
    state: State<'_, AppState>,
    days: Option<u32>,
) -> Result<openwhoop::sleep_history::SleepHistory, String> {
    let db = ensure_db(&state).await?;
    let days = days.unwrap_or(openwhoop::sleep_history::DEFAULT_HISTORY_DAYS);
    openwhoop::sleep_history::get_sleep_history(&db, days)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- battery prediction

async fn log_battery_reading(
    db: &DatabaseHandler,
    info: &BatteryInfo,
    avg_bpm: Option<i16>,
) {
    let model = battery_log::ActiveModel {
        id: NotSet,
        time: Set(info.updated_at),
        percent: Set(f64::from(info.percent)),
        charging: Set(info.charging),
        is_worn: Set(info.is_worn),
        avg_bpm: Set(avg_bpm),
    };
    let _ = battery_log::Entity::insert(model)
        .exec(db.connection())
        .await;
}

/// Estimate hours remaining from the battery_log table. Uses non-charging,
/// decreasing readings from the current discharge session (everything since
/// the last charging=true row). Returns None if there aren't at least 2
/// data points or if the drain rate is ≤ 0 (stale/charging).
async fn estimate_battery_remaining(
    db: &DatabaseHandler,
    current_percent: f32,
) -> Option<BatteryEstimate> {
    // Grab the last 200 readings, ordered newest first.
    let rows = battery_log::Entity::find()
        .order_by_desc(battery_log::Column::Time)
        .limit(200)
        .all(db.connection())
        .await
        .ok()?;

    if rows.len() < 2 {
        return None;
    }

    // (time, percent, charging) triples, newest first.
    let triples: Vec<(chrono::NaiveDateTime, f64, bool)> = rows
        .iter()
        .map(|r| (r.time, r.percent, r.charging))
        .collect();
    estimate_from_readings(&triples, f64::from(current_percent))
}

/// Cycle ends when we see a jump UP of > this many percent between
/// adjacent (newer → older) readings — interpreted as a charge we
/// missed because the tray wasn't running or the strap didn't emit a
/// charging-flagged reading during the charge window.
const CHARGE_JUMP_THRESHOLD: f64 = 2.0;

/// Cap the discharge window at this many hours of real time. Drain
/// rate shifts with usage pattern, and the most recent window best
/// predicts the next few hours. Spec is ~5 d at ~0.83%/h, so 18 h
/// of recent data is enough for a stable slope without being so
/// old that it washes out the current rate.
const MAX_WINDOW_HOURS: f64 = 18.0;

/// Pure: fit a drain rate from a newest-first sequence of readings
/// and project hours remaining at `current_percent`. Stops at
/// charging rows or missed-charge jumps. Returns `None` when
/// fewer than 2 usable points or non-draining slope.
fn estimate_from_readings(
    readings: &[(chrono::NaiveDateTime, f64, bool)],
    current_percent: f64,
) -> Option<BatteryEstimate> {
    if readings.len() < 2 {
        return None;
    }

    let mut discharge: Vec<(f64, f64)> = Vec::new();
    let now_time = readings[0].0;
    let mut prev_pct: Option<f64> = None;
    for &(t, pct, charging) in readings {
        if charging {
            break;
        }
        let hours_ago = (now_time - t).num_seconds() as f64 / 3600.0;
        if hours_ago > MAX_WINDOW_HOURS {
            break;
        }
        if let Some(prev) = prev_pct {
            // `row` is older than the previously-seen row. If the OLDER
            // row's percent is BELOW the newer row by more than the
            // threshold, that means the newer reading was post-charge
            // — stop before including this older-cycle data.
            if prev - pct > CHARGE_JUMP_THRESHOLD {
                break;
            }
        }
        // Flip sign so slope has conventional units: drain makes
        // slope negative (percent decreasing as hours_since_start
        // increases).
        let hours_since_start = -hours_ago;
        discharge.push((hours_since_start, pct));
        prev_pct = Some(pct);
    }

    if discharge.len() < 2 {
        return None;
    }

    // Simple linear regression: percent = a + b * hours.
    let n = discharge.len() as f64;
    let sum_x: f64 = discharge.iter().map(|(x, _)| x).sum();
    let sum_y: f64 = discharge.iter().map(|(_, y)| y).sum();
    let sum_xy: f64 = discharge.iter().map(|(x, y)| x * y).sum();
    let sum_xx: f64 = discharge.iter().map(|(x, _)| x * x).sum();

    let denom = n * sum_xx - sum_x * sum_x;
    if denom.abs() < 1e-9 {
        return None;
    }
    let slope = (n * sum_xy - sum_x * sum_y) / denom;

    let drain_rate = -slope;
    if drain_rate <= 0.01 {
        return None;
    }

    let hours_remaining = current_percent / drain_rate;

    let confidence = match discharge.len() {
        0..=5 => "low",
        6..=20 => "moderate",
        _ => "good",
    };

    Some(BatteryEstimate {
        hours_remaining: (hours_remaining * 10.0).round() / 10.0,
        drain_rate_pct_per_hour: (drain_rate * 100.0).round() / 100.0,
        data_points: discharge.len(),
        confidence,
    })
}

#[cfg(test)]
mod battery_tests {
    use super::*;
    use chrono::{Duration, NaiveDate, NaiveDateTime};

    fn t(mins_ago_from_anchor: i64) -> NaiveDateTime {
        // Anchor at 2026-04-22 17:00 and subtract minutes.
        let anchor = NaiveDate::from_ymd_opt(2026, 4, 22)
            .unwrap()
            .and_hms_opt(17, 0, 0)
            .unwrap();
        anchor - Duration::minutes(mins_ago_from_anchor)
    }

    #[test]
    fn linear_discharge_yields_expected_hours() {
        // 1%/hour drain, currently at 10%. Expect ~10 h remaining.
        let readings: Vec<_> = (0..10)
            .map(|i| (t(i * 60), 10.0 + i as f64, false))
            .collect();
        let est = estimate_from_readings(&readings, 10.0).unwrap();
        assert!((est.drain_rate_pct_per_hour - 1.0).abs() < 0.05);
        assert!((est.hours_remaining - 10.0).abs() < 0.5);
    }

    #[test]
    fn missed_charge_jump_is_detected() {
        // Reading sequence (newest first):
        //   5%, 6%, 7%, 8%  (current cycle, ~1%/hr drain)
        //   — hidden charge event here —
        //   2%, 3% (yesterday's tail — strap drained to near-empty
        //            before the charge we didn't capture)
        //
        // Going from the 8% (newer) to 2% (older) is a jump of +6
        // percent above 2% threshold → should end the cycle.
        let readings = vec![
            (t(0), 5.0, false),
            (t(60), 6.0, false),
            (t(120), 7.0, false),
            (t(180), 8.0, false),
            (t(240), 2.0, false), // prev(8) − row(2) = 6 > 2 → cycle ends
            (t(300), 3.0, false),
        ];
        let est = estimate_from_readings(&readings, 5.0).unwrap();
        // Drain rate should reflect only the 5–8% cycle → ~1%/hr.
        assert!(
            (est.drain_rate_pct_per_hour - 1.0).abs() < 0.2,
            "drain rate should be ~1%/hr, got {}",
            est.drain_rate_pct_per_hour
        );
        assert_eq!(est.data_points, 4);
        // 5% ÷ ~1%/hr ≈ 5 hours remaining, not the smeared-regression
        // result of over 50h.
        assert!(est.hours_remaining < 10.0);
    }

    #[test]
    fn charging_flag_ends_cycle() {
        let readings = vec![
            (t(0), 50.0, false),
            (t(60), 51.0, false),
            (t(120), 80.0, true), // charging — stop here
            (t(180), 85.0, false),
        ];
        let est = estimate_from_readings(&readings, 50.0).unwrap();
        // Only 2 points ingested (before the charging row).
        assert_eq!(est.data_points, 2);
    }

    #[test]
    fn window_cap_excludes_old_readings() {
        // 20h of data: first half drains at 2%/h, second half at 0.5%/h.
        // MAX_WINDOW_HOURS = 18, so the oldest 2h should be trimmed.
        // (In fact with these values the first ~18h of readings drop in.)
        let mut readings = Vec::new();
        for i in 0..20 {
            readings.push((t(i * 60), 50.0 + i as f64 * 0.5, false));
        }
        let est = estimate_from_readings(&readings, 50.0).unwrap();
        // Ensure we capped the window.
        assert!(est.data_points <= 19);
    }

    #[test]
    fn rising_battery_without_charging_flag_returns_none() {
        // Newer = higher % than older = battery was gaining over time.
        // This shouldn't happen without a charge event, but if the
        // `charging` bit is unreliable, a below-threshold jump-up
        // can sneak through. Regression slope is positive → drain
        // rate is negative → we refuse to predict.
        let rising = vec![
            (t(0), 51.0, false),
            (t(60), 50.0, false),
        ];
        assert!(
            estimate_from_readings(&rising, 51.0).is_none(),
            "rising battery without charging flag should return None",
        );
    }
}

/// Connect, fire the strap's haptic alarm, disconnect. No response handling —
/// this is the "find my strap" buzz-now command, not scheduling.
async fn do_ring_strap(app: AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    if *state.sync_in_progress.read().await {
        anyhow::bail!("Sync in progress — try again in a moment");
    }
    let device_name = state
        .config
        .read()
        .await
        .device_name
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Device not configured"))?;

    let db_arc = ensure_db_from_handle(&app)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let db: DatabaseHandler = (*db_arc).clone();

    let _ble_guard = state.ble_lock.clone().lock_owned().await;

    let manager = Manager::new().await?;
    let adapter = manager
        .adapters()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No Bluetooth adapter found"))?;

    let peripheral = scan_for_device(&adapter, &device_name).await?;
    let mut device = WhoopDevice::new(peripheral, adapter, db, false, WhoopGeneration::Gen4);
    device.connect().await?;
    device.send_command(WhoopPacket::run_alarm()).await?;

    *state.strap_seen_at.write().await = Some(Local::now().naive_local());
    Ok(())
}

#[derive(Clone, Copy)]
enum AlarmOp {
    Read,
    Set(u32),
    Clear,
}

/// Connect to the strap, perform an alarm operation, and read back the
/// resulting state so the UI can confirm what the strap actually has. Reuses
/// the BLE lock so it can't race with sync or presence ping.
async fn do_alarm_op(app: AppHandle, op: AlarmOp) -> anyhow::Result<AlarmStatus> {
    let state = app.state::<AppState>();

    if *state.sync_in_progress.read().await {
        anyhow::bail!("Sync in progress — try again in a moment");
    }

    let device_name = state
        .config
        .read()
        .await
        .device_name
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Device not configured"))?;

    let db_arc = ensure_db_from_handle(&app)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let db: DatabaseHandler = (*db_arc).clone();

    // Hold the BLE adapter for the whole round trip.
    let _ble_guard = state.ble_lock.clone().lock_owned().await;

    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No Bluetooth adapter found"))?;

    let peripheral = scan_for_device(&adapter, &device_name).await?;
    let mut device = WhoopDevice::new(peripheral, adapter, db, false, WhoopGeneration::Gen4);
    device.connect().await?;

    // Apply the change. set/clear don't return useful responses, so we
    // always follow with get_alarm to confirm.
    if let AlarmOp::Set(unix) = op {
        device.send_command(WhoopPacket::alarm_time(unix, WhoopGeneration::Gen4)).await?;
    }
    if matches!(op, AlarmOp::Clear) {
        device.send_command(WhoopPacket::disable_alarm()).await?;
    }

    // Tiny delay so the strap has a moment to commit set/clear before we
    // read it back.
    if !matches!(op, AlarmOp::Read) {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let info = device.get_alarm().await?;
    let status = match info {
        WhoopData::AlarmInfo { enabled, unix } => AlarmStatus {
            enabled,
            at: enabled.then(|| {
                chrono::DateTime::from_timestamp(i64::from(unix), 0)
                    .map(|dt| dt.with_timezone(&Local).naive_local())
                    .unwrap_or_else(|| Local::now().naive_local())
            }),
        },
        _ => anyhow::bail!("unexpected response to GetAlarmTime"),
    };

    *state.alarm.write().await = Some(status);
    *state.strap_seen_at.write().await = Some(Local::now().naive_local());
    let _ = app.emit("alarm:updated", status);

    Ok(status)
}

#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<Config, String> {
    Ok(state.config.read().await.clone())
}

#[tauri::command]
async fn set_device_name(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    let path = state
        .config_path
        .read()
        .await
        .clone()
        .ok_or_else(|| "config path not initialized".to_string())?;

    {
        let mut cfg = state.config.write().await;
        cfg.device_name = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
        cfg.save(&path).map_err(|e| e.to_string())?;
    }
    state.scheduler_notify.notify_one();
    Ok(())
}

#[tauri::command]
async fn set_sync_interval(
    state: State<'_, AppState>,
    minutes: Option<u32>,
) -> Result<(), String> {
    let path = state
        .config_path
        .read()
        .await
        .clone()
        .ok_or_else(|| "config path not initialized".to_string())?;
    {
        let mut cfg = state.config.write().await;
        cfg.sync_interval_minutes = minutes.and_then(|m| (m > 0).then_some(m));
        cfg.save(&path).map_err(|e| e.to_string())?;
    }
    state.scheduler_notify.notify_one();
    Ok(())
}

#[tauri::command]
async fn set_allow_surplus_banking(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let path = state
        .config_path
        .read()
        .await
        .clone()
        .ok_or_else(|| "config path not initialized".to_string())?;
    {
        let mut cfg = state.config.write().await;
        cfg.allow_surplus_banking = enabled;
        cfg.save(&path).map_err(|e| e.to_string())?;
    }
    // Next sync will re-run staging with the new flag (via
    // stage_sleep_with_opts once the vendor/openwhoop submodule is
    // bumped to the commit that introduced StageSleepOptions).
    Ok(())
}

#[tauri::command]
async fn set_presence_interval(
    state: State<'_, AppState>,
    minutes: Option<u32>,
) -> Result<(), String> {
    let path = state
        .config_path
        .read()
        .await
        .clone()
        .ok_or_else(|| "config path not initialized".to_string())?;
    {
        let mut cfg = state.config.write().await;
        cfg.presence_interval_minutes = minutes;
        cfg.save(&path).map_err(|e| e.to_string())?;
    }
    state.presence_notify.notify_one();
    Ok(())
}

#[tauri::command]
async fn set_dob(state: State<'_, AppState>, iso: Option<String>) -> Result<(), String> {
    // iso is "YYYY-MM-DD"; None / empty clears the setting.
    let dob = match iso.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(
            NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| format!("invalid date: {e}"))?,
        ),
    };
    let path = state
        .config_path
        .read()
        .await
        .clone()
        .ok_or_else(|| "config path not initialized".to_string())?;
    let mut cfg = state.config.write().await;
    cfg.dob = dob;
    cfg.save(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn scan_devices(app: AppHandle) -> Result<Vec<DiscoveredDevice>, String> {
    let manager = Manager::new().await.map_err(|e| e.to_string())?;
    let adapters = manager.adapters().await.map_err(|e| e.to_string())?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| "No Bluetooth adapter found".to_string())?;

    adapter
        .start_scan(ScanFilter {
            services: vec![WHOOP_SERVICE],
        })
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit("scan:started", ());

    // Poll for ~8 seconds so a nearby strap has a chance to advertise.
    tokio::time::sleep(Duration::from_secs(8)).await;

    let mut results: Vec<DiscoveredDevice> = Vec::new();
    for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
        let Ok(Some(props)) = p.properties().await else {
            continue;
        };
        if !props.services.contains(&WHOOP_SERVICE) {
            continue;
        }
        if let Some(name) = props.local_name {
            let sanitized = sanitize_name(&name);
            if !sanitized.is_empty() {
                results.push(DiscoveredDevice {
                    name: sanitized,
                    rssi: props.rssi,
                });
            }
        }
    }
    let _ = adapter.stop_scan().await;

    // Dedupe by name, keep the strongest signal.
    results.sort_by(|a, b| b.rssi.cmp(&a.rssi));
    results.dedup_by(|a, b| a.name == b.name);

    let _ = app.emit("scan:done", results.len());
    Ok(results)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    do_sync_guarded(app).await.map_err(|e| e.to_string())
}

async fn do_sync_guarded(app: AppHandle) -> anyhow::Result<SyncReport> {
    let state = app.state::<AppState>();
    if state.live_active.load(Ordering::SeqCst) {
        anyhow::bail!("Live stream is running — stop it before syncing");
    }
    {
        let mut flag = state.sync_in_progress.write().await;
        if *flag {
            anyhow::bail!("sync already in progress");
        }
        *flag = true;
    }
    state.sync_cancel.store(false, Ordering::SeqCst);
    *state.sync_cancel_reason.write().await = None;
    *state.last_sync_attempt_at.write().await = Some(Local::now().naive_local());

    // Wait for any in-flight presence ping to release the BLE adapter,
    // then hold the lock for the duration of the sync.
    let _ble_guard = state.ble_lock.clone().lock_owned().await;
    let result = do_sync(app.clone()).await;
    drop(_ble_guard);

    *state.sync_in_progress.write().await = false;
    if result.is_ok() {
        let now = Local::now().naive_local();
        *state.last_sync_at.write().await = Some(now);
        // Successful connect implies the strap was nearby.
        *state.strap_seen_at.write().await = Some(now);
    }
    result
}

// ---------------------------------------------------------------- sync pipeline

async fn do_sync(app: AppHandle) -> anyhow::Result<SyncReport> {
    let state = app.state::<AppState>();
    let device_name = state
        .config
        .read()
        .await
        .device_name
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Device not configured"))?;

    let db_arc = ensure_db_from_handle(&app)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let db: DatabaseHandler = (*db_arc).clone();

    run_sync(&app, db, device_name).await
}

async fn run_sync(
    app: &AppHandle,
    db: DatabaseHandler,
    device_name: String,
) -> anyhow::Result<SyncReport> {
    const SYNC_TIMEOUT: Duration = Duration::from_secs(900);

    let start = Instant::now();
    let before = heart_rate::Entity::find().count(db.connection()).await? as usize;

    let state_arc = app.state::<AppState>();
    let cancel = state_arc.sync_cancel.clone();
    let cancel_reason = state_arc.sync_cancel_reason.clone();

    // Hard timeout: a parallel task flips the cancel flag after SYNC_TIMEOUT.
    // sync_history checks the flag at the top of each iteration, so it will
    // unwind cleanly. Aborted on success.
    let timeout_cancel = cancel.clone();
    let timeout_reason = cancel_reason.clone();
    let timeout_task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SYNC_TIMEOUT).await;
        *timeout_reason.write().await = Some(CancelReason::HardTimeout);
        timeout_cancel.store(true, Ordering::SeqCst);
    });

    emit_progress(app, "scanning");
    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No Bluetooth adapter found"))?;

    let peripheral = scan_for_device(&adapter, &device_name).await?;
    // Strap responded to the scan — mark presence even if later steps fail.
    *app.state::<AppState>().strap_seen_at.write().await = Some(Local::now().naive_local());

    emit_progress(app, "connecting");
    let mut device = WhoopDevice::new(peripheral, adapter, db.clone(), false, WhoopGeneration::Gen4);
    device.connect().await?;
    device.initialize().await?;

    emit_progress(app, "downloading");

    // Spawn a parallel task that polls the heart_rate row count every 3s and
    // emits progress events so the UI can show "Downloading… N readings".
    // Doubles as a stall detector: if the count hasn't advanced for 30s after
    // we've already received at least one packet, fire the cancel flag with
    // a NoProgress reason so the user gets a friendly recovery message
    // instead of waiting out the 5-minute hard timeout.
    let progress_app = app.clone();
    let progress_db = db.clone();
    let progress_baseline = before;
    let progress_cancel = cancel.clone();
    let progress_reason = cancel_reason.clone();
    let progress_task = tauri::async_runtime::spawn(async move {
        const STALL_THRESHOLD: Duration = Duration::from_secs(30);
        let mut last_count = progress_baseline;
        let mut last_progress_at = Instant::now();
        let mut received_any = false;

        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let Ok(count) = heart_rate::Entity::find()
                .count(progress_db.connection())
                .await
            else {
                continue;
            };
            let count = count as usize;
            let new = count.saturating_sub(progress_baseline);
            let _ = progress_app.emit("sync:download_progress", new);

            if count > last_count {
                last_count = count;
                last_progress_at = Instant::now();
                received_any = true;
            } else if received_any && last_progress_at.elapsed() >= STALL_THRESHOLD {
                eprintln!(
                    "openwhoop-tray: download stalled ({}s), cancelling",
                    last_progress_at.elapsed().as_secs()
                );
                *progress_reason.write().await = Some(CancelReason::NoProgress);
                progress_cancel.store(true, Ordering::SeqCst);
                break;
            }
        }
    });

    let sync_result = device
        .sync_history(cancel.clone(), openwhoop::HistorySyncConfig::default())
        .await;
    progress_task.abort();
    timeout_task.abort();
    sync_result?;

    if cancel.load(Ordering::SeqCst) {
        let reason = *cancel_reason.read().await;
        match reason {
            Some(CancelReason::HardTimeout) => anyhow::bail!(
                "Sync timed out after {} seconds — strap may be out of range or unresponsive",
                start.elapsed().as_secs()
            ),
            Some(CancelReason::NoProgress) => anyhow::bail!(
                "Strap stopped sending data after 30 seconds of inactivity — try again or reboot the strap"
            ),
            Some(CancelReason::User) | None => anyhow::bail!("Sync cancelled"),
        }
    }

    // Battery + wrist/charging state via the custom command protocol. Uses
    // GetBatteryLevel (26) and GetHelloHarvard (35). Failures are non-fatal.
    let battery = match read_device_status(&mut device).await {
        Ok(info) => {
            let state = app.state::<AppState>();
            *state.battery.write().await = Some(info);
            // Compute recent avg bpm as context for drain-rate segmentation.
            let avg_bpm = {
                let now = Local::now().naive_local();
                let ten_min_ago = now - TimeDelta::minutes(10);
                let recent: Vec<heart_rate::Model> = heart_rate::Entity::find()
                    .filter(heart_rate::Column::Time.gte(ten_min_ago))
                    .all(db.connection())
                    .await
                    .unwrap_or_default();
                if recent.is_empty() {
                    None
                } else {
                    let sum: i64 = recent.iter().map(|r| i64::from(r.bpm)).sum();
                    Some((sum / recent.len() as i64) as i16)
                }
            };
            log_battery_reading(&db, &info, avg_bpm).await;
            Some(info)
        }
        Err(e) => {
            eprintln!("device status read failed: {}", e);
            None
        }
    };

    if device.is_connected().await.unwrap_or(false) {
        let _ = device
            .send_command(WhoopPacket::exit_high_freq_sync())
            .await;
    }

    emit_progress(app, "processing");
    let whoop = OpenWhoop::new(db.clone(), WhoopGeneration::Gen4);
    whoop.detect_sleeps().await?;
    whoop.detect_events().await?;
    whoop.calculate_stress().await?;
    whoop.calculate_spo2().await?;
    whoop.calculate_skin_temp().await?;
    whoop.update_wear_periods().await?;
    let stage_opts = {
        let app_state = app.state::<AppState>();
        let cfg = app_state.config.read().await;
        openwhoop::sleep_staging::StageSleepOptions {
            allow_surplus_banking: cfg.allow_surplus_banking,
        }
    };
    whoop.stage_sleep_with_opts(stage_opts).await?;
    whoop.compute_daytime_hrv().await?;
    whoop.classify_activities().await?;

    let after = heart_rate::Entity::find().count(db.connection()).await? as usize;
    let sleep_nights = db.get_sleep_cycles(None).await?.len();
    let activities = db
        .search_activities(SearchActivityPeriods::default())
        .await?
        .len();

    let report = SyncReport {
        duration_secs: start.elapsed().as_secs_f64(),
        new_readings: after.saturating_sub(before),
        total_readings: after,
        sleep_nights,
        activities,
        battery,
    };

    emit_progress(app, "done");
    Ok(report)
}

fn emit_progress(app: &AppHandle, stage: &str) {
    let _ = app.emit("sync:progress", stage);
}

async fn scan_for_device(
    adapter: &Adapter,
    name_prefix: &str,
) -> anyhow::Result<Peripheral> {
    adapter
        .start_scan(ScanFilter {
            services: vec![WHOOP_SERVICE],
        })
        .await?;

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() > deadline {
            let _ = adapter.stop_scan().await;
            anyhow::bail!("Device '{}' not found within 30s", name_prefix);
        }

        for peripheral in adapter.peripherals().await? {
            let Ok(Some(properties)) = peripheral.properties().await else {
                continue;
            };
            if !properties.services.contains(&WHOOP_SERVICE) {
                continue;
            }
            let Some(local_name) = properties.local_name else {
                continue;
            };
            if sanitize_name(&local_name).starts_with(name_prefix) {
                return Ok(peripheral);
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// Query battery level + wrist/charging state via the custom WHOOP command
/// protocol (GetBatteryLevel and GetHelloHarvard), not the standard BLE
/// Battery Service — that characteristic exists on the strap but returns a
/// stale value.
async fn read_device_status(device: &mut WhoopDevice) -> anyhow::Result<BatteryInfo> {
    let percent = device.get_battery().await?;
    let (charging, is_worn) = device.get_hello().await?;
    Ok(BatteryInfo {
        percent,
        charging,
        is_worn,
        updated_at: Local::now().naive_local(),
    })
}

// ---------------------------------------------------------------- snapshot build

async fn build_snapshot(
    db: &DatabaseHandler,
    battery: Option<BatteryInfo>,
    last_sync_at: Option<NaiveDateTime>,
    last_sync_attempt_at: Option<NaiveDateTime>,
    next_sync_at: Option<NaiveDateTime>,
    sync_in_progress: bool,
    strap_seen_at: Option<NaiveDateTime>,
    alarm: Option<AlarmStatus>,
    battery_estimate: Option<BatteryEstimate>,
    age_years: Option<u32>,
) -> anyhow::Result<Snapshot> {
    let now = Local::now().naive_local();
    let today = now.date();
    let day_start = today.and_hms_opt(0, 0, 0).unwrap();
    let week_start = (today - chrono::Days::new(7)).and_hms_opt(0, 0, 0).unwrap();

    let today_rows = heart_rate::Entity::find()
        .filter(heart_rate::Column::Time.gte(day_start))
        .order_by_asc(heart_rate::Column::Time)
        .all(db.connection())
        .await?;

    let sleep_cycles = db.get_sleep_cycles(None).await?;
    let recent_activities = db
        .search_activities(SearchActivityPeriods {
            from: Some(week_start),
            to: None,
            activity: None,
        })
        .await?;

    // Chart series: last 24h (not just today) so the 24H chart scale works
    // even right after midnight.
    let twenty_four_ago = now - TimeDelta::hours(24);
    let hr_series: Vec<HrPoint> = heart_rate::Entity::find()
        .filter(heart_rate::Column::Time.gte(twenty_four_ago))
        .order_by_asc(heart_rate::Column::Time)
        .all(db.connection())
        .await?
        .iter()
        .map(|r| HrPoint {
            t: r.time,
            b: r.bpm.max(0).min(255) as u8,
        })
        .collect();

    let recovery = build_recovery_section(db, age_years)
        .await
        .unwrap_or_else(|e| {
            eprintln!("openwhoop-tray: recovery computation failed: {}", e);
            None
        });

    Ok(Snapshot {
        generated_at: now,
        today: build_today(&today_rows, hr_series),
        latest_sleep: sleep_cycles.last().map(build_sleep_section),
        recovery,
        week: build_week(&sleep_cycles, &recent_activities, week_start)?,
        recent_activities: build_activity_list(&recent_activities),
        battery,
        last_sync_at,
        last_sync_attempt_at,
        next_sync_at,
        sync_in_progress,
        strap_seen_at,
        alarm,
        battery_estimate,
    })
}

/// Fetch the most recent sleep cycle + up to 14 prior nights for baseline,
/// then run the recovery algorithm. Returns `None` if no cycles exist or
/// the baseline is too short to produce a meaningful score.
async fn build_recovery_section(
    db: &DatabaseHandler,
    age_years: Option<u32>,
) -> anyhow::Result<Option<RecoverySection>> {
    // Most-recent first. Fetch 15 = 1 current + 14 baseline.
    let rows: Vec<sleep_cycles::Model> = sleep_cycles::Entity::find()
        .order_by_desc(sleep_cycles::Column::Start)
        .limit(15)
        .all(db.connection())
        .await?;

    let Some((current, baseline_rows)) = rows.split_first() else {
        return Ok(None);
    };

    let to_night = |m: &sleep_cycles::Model| RecoveryNight {
        hrv_rmssd_ms: f64::from(m.avg_hrv),
        rhr_bpm: f64::from(m.min_bpm.max(0)),
        avg_resp_rate: m.avg_respiratory_rate,
        sleep_performance_score: m.performance_score,
        skin_temp_deviation_c: m.skin_temp_deviation_c,
    };

    let today = to_night(current);
    let baseline: Vec<RecoveryNight> = baseline_rows.iter().map(to_night).collect();

    let Some(r) = compute_recovery(&today, &baseline) else {
        return Ok(None);
    };

    let band = match r.band {
        RecoveryBand::Red => "red",
        RecoveryBand::Yellow => "yellow",
        RecoveryBand::Green => "green",
    };
    let dominant_driver = match r.dominant_driver {
        RecoveryDriver::Hrv => "hrv",
        RecoveryDriver::Rhr => "rhr",
        RecoveryDriver::Sleep => "sleep",
        RecoveryDriver::Rr => "rr",
        RecoveryDriver::SkinTemp => "skin_temp",
        RecoveryDriver::None => "none",
    };

    let hrv_rmssd_ms = Some(f64::from(current.avg_hrv)).filter(|v| *v > 0.0);
    let age_normed =
        age_years.and_then(|age| hrv_rmssd_ms.map(|ms| age_normed_hrv_score(ms, age)));

    Ok(Some(RecoverySection {
        score: r.score,
        band,
        dominant_driver,
        for_sleep_id: current.sleep_id,
        baseline_window_nights: r.baseline_window_nights,
        calibrating: r.calibrating,
        z_hrv: r.z_scores.hrv,
        z_rhr: r.z_scores.rhr,
        z_sleep: r.z_scores.sleep,
        z_rr: r.z_scores.rr,
        z_skin_temp: r.z_scores.skin_temp,
        hrv_rmssd_ms,
        age_normed_hrv_score: age_normed,
    }))
}

fn build_today(rows: &[heart_rate::Model], series_rows: Vec<HrPoint>) -> TodaySection {
    if rows.is_empty() {
        return TodaySection {
            sample_count: 0,
            last_seen: None,
            current_bpm: None,
            min_bpm: None,
            avg_bpm: None,
            max_bpm: None,
            latest_stress: None,
            latest_spo2: None,
            latest_skin_temp: None,
            hourly_bpm: [None; 24],
            hr_series: series_rows,
        };
    }

    let bpms: Vec<u8> = rows
        .iter()
        .map(|r| r.bpm.max(0).min(255) as u8)
        .collect();
    let min_bpm = *bpms.iter().min().unwrap();
    let max_bpm = *bpms.iter().max().unwrap();
    let avg_bpm =
        (bpms.iter().map(|&b| u32::from(b)).sum::<u32>() / bpms.len() as u32) as u8;

    let mut sums = [0u32; 24];
    let mut counts = [0u32; 24];
    for r in rows {
        let h = r.time.hour() as usize;
        sums[h] += u32::from(r.bpm.max(0) as u16);
        counts[h] += 1;
    }
    let mut hourly = [None; 24];
    for h in 0..24 {
        if counts[h] > 0 {
            hourly[h] = Some((sums[h] / counts[h]) as u16);
        }
    }

    TodaySection {
        sample_count: rows.len(),
        last_seen: Some(rows.last().unwrap().time),
        current_bpm: Some(*bpms.last().unwrap()),
        min_bpm: Some(min_bpm),
        avg_bpm: Some(avg_bpm),
        max_bpm: Some(max_bpm),
        latest_stress: rows.iter().rev().find_map(|r| r.stress),
        latest_spo2: rows.iter().rev().find_map(|r| r.spo2),
        latest_skin_temp: rows.iter().rev().find_map(|r| r.skin_temp),
        hourly_bpm: hourly,
        hr_series: series_rows,
    }
}

fn build_sleep_section(s: &SleepCycle) -> SleepSection {
    let duration = (s.end - s.start).num_minutes();
    // "Night of" = the evening the user went to bed. Shifting bedtime back 12h
    // maps a post-midnight start (e.g. 01:12 Sun) to the prior evening (Sat).
    let night_of = (s.start - TimeDelta::hours(12)).date();
    SleepSection {
        night: night_of.format("%a %b %d").to_string(),
        start: s.start,
        end: s.end,
        duration_minutes: duration,
        score: s.score,
        min_bpm: s.min_bpm,
        avg_bpm: s.avg_bpm,
        max_bpm: s.max_bpm,
        min_hrv: s.min_hrv,
        avg_hrv: s.avg_hrv,
        max_hrv: s.max_hrv,
    }
}

fn build_week(
    sleep: &[SleepCycle],
    activities: &[ActivityPeriod],
    week_start: NaiveDateTime,
) -> anyhow::Result<WeekSection> {
    let week_sleep: Vec<SleepCycle> = sleep
        .iter()
        .filter(|s| s.start >= week_start)
        .copied()
        .collect();

    let (avg_dur, avg_score, consistency) = if week_sleep.is_empty() {
        (None, None, None)
    } else {
        let total_secs: i64 = week_sleep.iter().map(|s| (s.end - s.start).num_seconds()).sum();
        let avg_dur_min = total_secs / 60 / week_sleep.len() as i64;
        let avg_score = week_sleep.iter().map(|s| s.score).sum::<f64>()
            / week_sleep.len() as f64;
        let consistency = SleepConsistencyAnalyzer::new(week_sleep.clone())
            .calculate_consistency_metrics()
            .ok()
            .map(|m| m.score.total_score);
        (Some(avg_dur_min), Some(avg_score), consistency)
    };

    let workouts: Vec<&ActivityPeriod> = activities
        .iter()
        .filter(|a| matches!(a.activity, ActivityType::Activity))
        .collect();
    let workout_total_minutes: i64 =
        workouts.iter().map(|a| (a.to - a.from).num_minutes()).sum();

    Ok(WeekSection {
        sleep_nights: week_sleep.len(),
        avg_sleep_duration_minutes: avg_dur,
        avg_sleep_score: avg_score,
        consistency_score: consistency,
        workout_count: workouts.len(),
        workout_total_minutes,
    })
}

fn build_activity_list(activities: &[ActivityPeriod]) -> Vec<ActivitySummary> {
    let mut workouts: Vec<&ActivityPeriod> = activities
        .iter()
        .filter(|a| matches!(a.activity, ActivityType::Activity))
        .collect();
    workouts.sort_by_key(|a| std::cmp::Reverse(a.from));
    workouts
        .into_iter()
        .take(5)
        .map(|a| ActivitySummary {
            kind: format!("{:?}", a.activity),
            start: a.from,
            end: a.to,
            duration_minutes: (a.to - a.from).num_minutes(),
        })
        .collect()
}

// ---------------------------------------------------------------- window + tray

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn format_tray_status(
    syncing: bool,
    battery: Option<BatteryInfo>,
    strap_seen: Option<NaiveDateTime>,
    last_sync: Option<NaiveDateTime>,
    next_sync: Option<NaiveDateTime>,
) -> (String, String) {
    if syncing {
        return (
            "Syncing…".to_string(),
            "OpenWhoop\nSyncing with strap…".to_string(),
        );
    }

    let now = Local::now().naive_local();

    if battery.is_none() && strap_seen.is_none() && last_sync.is_none() {
        return (
            "No data yet".to_string(),
            "OpenWhoop\nWaiting for first sync".to_string(),
        );
    }

    fn relative_mins(from: NaiveDateTime, to: NaiveDateTime) -> String {
        let mins = (to - from).num_minutes().max(0);
        if mins < 1 {
            "just now".to_string()
        } else if mins < 60 {
            format!("{}m ago", mins)
        } else {
            format!("{}h ago", mins / 60)
        }
    }

    let battery_str = battery
        .map(|b| format!("{:.1}%{}", b.percent, if b.charging { " ⚡" } else { "" }))
        .unwrap_or_else(|| "— battery".to_string());

    let presence_str = match strap_seen {
        Some(t) if (now - t).num_minutes() < 5 => "in range".to_string(),
        Some(t) => format!("seen {}", relative_mins(t, now)),
        None => "not detected".to_string(),
    };

    let sync_str = last_sync
        .map(|t| relative_mins(t, now))
        .unwrap_or_else(|| "never".to_string());

    let menu_text = format!("{} · {} · synced {}", battery_str, presence_str, sync_str);

    let mut tooltip = String::from("OpenWhoop\n");
    if let Some(b) = battery {
        tooltip.push_str(&format!(
            "Battery: {:.1}%{}\nOn wrist: {}\n",
            b.percent,
            if b.charging { " (charging)" } else { "" },
            if b.is_worn { "yes" } else { "no" }
        ));
    }
    tooltip.push_str(&format!("Strap: {}\n", presence_str));
    tooltip.push_str(&format!("Last sync: {}", sync_str));
    if let Some(t) = next_sync {
        let mins = (t - now).num_minutes();
        if mins > 0 {
            tooltip.push_str(&format!("\nNext sync: in {}m", mins));
        }
    }

    (menu_text, tooltip)
}

async fn update_tray_status(app: &AppHandle, status_item: &MenuItem<Wry>) {
    let state = app.state::<AppState>();
    let syncing = *state.sync_in_progress.read().await;
    let battery = *state.battery.read().await;
    let strap_seen = *state.strap_seen_at.read().await;
    let last_sync = *state.last_sync_at.read().await;
    let next_sync = *state.next_sync_at.read().await;

    let (menu_text, tooltip) =
        format_tray_status(syncing, battery, strap_seen, last_sync, next_sync);

    let _ = status_item.set_text(menu_text);
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

async fn tray_update_loop(app: AppHandle, status_item: MenuItem<Wry>) {
    loop {
        update_tray_status(&app, &status_item).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

fn trigger_sync_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match do_sync_guarded(app.clone()).await {
            Ok(report) => {
                let _ = app.emit("sync:complete", report);
            }
            Err(e) => {
                let _ = app.emit("sync:error", e.to_string());
            }
        }
    });
}

/// Long-running scheduler task. Runs the initial sync on startup (if the
/// device is configured), then sleeps until the next interval or until the
/// scheduler_notify is triggered (e.g. by set_sync_interval / set_device_name).
async fn scheduler_loop(app: AppHandle) {
    // Give the runtime a moment to finish setup before the first sync.
    tokio::time::sleep(Duration::from_secs(2)).await;

    loop {
        let state = app.state::<AppState>();

        let (interval_mins, has_device) = {
            let cfg = state.config.read().await;
            (
                cfg.sync_interval_minutes.unwrap_or(0),
                cfg.device_name.is_some(),
            )
        };

        if !has_device {
            *state.next_sync_at.write().await = None;
            state.scheduler_notify.notified().await;
            continue;
        }

        // Decide when the next sync should run. Use last_sync_attempt_at
        // (not last_sync_at) so failed attempts still advance the schedule
        // and we don't spin trying to reach a strap that's out of range.
        let now = Local::now().naive_local();
        let last_attempt = *state.last_sync_attempt_at.read().await;
        let next = match (last_attempt, interval_mins) {
            (None, _) => now,
            (Some(_), 0) => {
                *state.next_sync_at.write().await = None;
                state.scheduler_notify.notified().await;
                continue;
            }
            (Some(t), mins) => t + TimeDelta::minutes(mins as i64),
        };
        *state.next_sync_at.write().await = Some(next);

        let wait = (next - Local::now().naive_local())
            .to_std()
            .unwrap_or(Duration::ZERO);

        // Sleep until due, or wake early on settings change.
        let notify = state.scheduler_notify.clone();
        tokio::select! {
            _ = tokio::time::sleep(wait) => {
                run_scheduled_sync(&app).await;
            }
            _ = notify.notified() => {
                // Settings changed — recompute.
                continue;
            }
        }
    }
}

async fn run_scheduled_sync(app: &AppHandle) {
    // Skip silently if another sync is already running — don't spam the
    // user with "already in progress" errors from the scheduler.
    if *app.state::<AppState>().sync_in_progress.read().await {
        return;
    }

    match do_sync_guarded(app.clone()).await {
        Ok(report) => {
            let _ = app.emit("sync:complete", report);

            let state = app.state::<AppState>();
            if state.alarm.read().await.is_none() {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = do_alarm_op(app_clone, AlarmOp::Read).await {
                        eprintln!("startup alarm fetch failed: {}", e);
                    }
                });
            }
        }
        Err(e) => {
            eprintln!("scheduled sync failed: {}", e);
            let _ = app.emit("sync:error", e.to_string());
        }
    }
}

/// Lightweight presence detector. Reads the configured presence interval
/// from app config and sleeps that long between 5-second BLE scans. Updates
/// strap_seen_at on hit, and triggers an immediate sync on absent→present
/// transitions so the user doesn't have to wait for the next scheduled tick.
async fn presence_loop(app: AppHandle) {
    let mut last_seen = false;

    loop {
        let state = app.state::<AppState>();
        let interval = effective_presence_minutes(&*state.config.read().await);
        let notify = state.presence_notify.clone();

        let Some(minutes) = interval else {
            // Disabled — wait for a settings change.
            notify.notified().await;
            continue;
        };

        // Sleep for the interval, but wake early if settings change.
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(u64::from(minutes) * 60)) => {}
            _ = notify.notified() => { continue; }
        }

        let state = app.state::<AppState>();

        // Skip if a sync is in flight — it'll update strap_seen_at itself.
        if *state.sync_in_progress.read().await {
            continue;
        }

        let device_name = {
            let cfg = state.config.read().await;
            cfg.device_name.clone()
        };
        let Some(device_name) = device_name else {
            continue;
        };

        // try_lock so we never hold the BLE adapter away from a sync request.
        let in_range = {
            let Ok(_guard) = state.ble_lock.clone().try_lock_owned() else {
                continue;
            };
            quick_presence_scan(&device_name).await
        };

        if in_range {
            *state.strap_seen_at.write().await = Some(Local::now().naive_local());
        }

        // Strap just came back into range: kick off a sync.
        if in_range && !last_seen && !*state.sync_in_progress.read().await {
            eprintln!("openwhoop-tray: strap returned to range, triggering sync");
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                match do_sync_guarded(app_clone.clone()).await {
                    Ok(report) => {
                        let _ = app_clone.emit("sync:complete", report);
                    }
                    Err(e) => {
                        let _ = app_clone.emit("sync:error", e.to_string());
                    }
                }
            });
        }
        last_seen = in_range;
    }
}

async fn quick_presence_scan(device_name: &str) -> bool {
    let Ok(manager) = Manager::new().await else {
        return false;
    };
    let Ok(adapters) = manager.adapters().await else {
        return false;
    };
    let Some(adapter) = adapters.into_iter().next() else {
        return false;
    };
    if adapter
        .start_scan(ScanFilter {
            services: vec![WHOOP_SERVICE],
        })
        .await
        .is_err()
    {
        return false;
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(peripherals) = adapter.peripherals().await {
            for p in peripherals {
                if let Ok(Some(props)) = p.properties().await {
                    if !props.services.contains(&WHOOP_SERVICE) {
                        continue;
                    }
                    if let Some(name) = props.local_name {
                        if sanitize_name(&name).starts_with(device_name) {
                            let _ = adapter.stop_scan().await;
                            return true;
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = adapter.stop_scan().await;
    false
}

// ---------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            db: RwLock::new(None),
            db_path: RwLock::new(None),
            config: RwLock::new(Config::default()),
            config_path: RwLock::new(None),
            battery: RwLock::new(None),
            sync_in_progress: RwLock::new(false),
            last_sync_at: RwLock::new(None),
            last_sync_attempt_at: RwLock::new(None),
            next_sync_at: RwLock::new(None),
            scheduler_notify: Arc::new(Notify::new()),
            presence_notify: Arc::new(Notify::new()),
            sync_cancel: Arc::new(AtomicBool::new(false)),
            sync_cancel_reason: Arc::new(RwLock::new(None)),
            strap_seen_at: RwLock::new(None),
            ble_lock: Arc::new(Mutex::new(())),
            alarm: RwLock::new(None),
            live_active: Arc::new(AtomicBool::new(false)),
            live_cancel: Arc::new(Notify::new()),
        })
        .setup(|app| {
            // Config path: ~/Library/Application Support/dev.brennen.openwhoop-tray/config.json
            let app_data = app.path().app_data_dir().ok();
            if let Some(ref dir) = app_data {
                std::fs::create_dir_all(dir).ok();
            }
            let db_path_str = app_data
                .as_ref()
                .and_then(|p| p.join("db.sqlite").to_str().map(String::from))
                .map(|p| format!("sqlite://{}?mode=rwc", p))
                .unwrap_or_else(|| "sqlite://db.sqlite?mode=rwc".to_string());
            let config_path = app_data.map(|p| p.join("config.json"));

            let loaded_config = config_path
                .as_ref()
                .map(Config::load)
                .unwrap_or_default();
            let first_run = loaded_config.device_name.is_none();

            let state = app.state::<AppState>();
            let db_path_clone = db_path_str.clone();
            let cfg_clone = loaded_config.clone();
            let cfg_path_clone = config_path.clone();
            tauri::async_runtime::block_on(async move {
                *state.db_path.write().await = Some(db_path_clone);
                *state.config.write().await = cfg_clone;
                *state.config_path.write().await = cfg_path_clone;
            });

            eprintln!("openwhoop-tray: db = {}", db_path_str);

            // Hide from dock on macOS so this feels like a menu bar app.
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if first_run {
                show_main_window(&app.handle());
            }

            // Tray icon
            let status_item =
                MenuItem::with_id(app, "status", "Loading…", false, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let show_item =
                MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
            let sync_item =
                MenuItem::with_id(app, "sync", "Sync Now", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit OpenWhoop", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&status_item, &separator, &show_item, &sync_item, &quit_item],
            )?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "sync" => trigger_sync_from_tray(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Background scheduler: runs an immediate sync at startup
            // (if the device is configured) and then cycles based on
            // the user's sync_interval_minutes setting.
            let scheduler_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                scheduler_loop(scheduler_handle).await;
            });

            // Presence ping loop — quick BLE scan every 2 minutes so the
            // UI can show whether the strap is currently in range, and so
            // we auto-sync when the user comes back into range.
            let presence_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                presence_loop(presence_handle).await;
            });

            // Tray status updater — refreshes the first menu item and the
            // tray tooltip every 10s so the user can check battery /
            // presence / last sync without opening the window.
            let tray_handle = app.handle().clone();
            let tray_status_clone = status_item.clone();
            tauri::async_runtime::spawn(async move {
                tray_update_loop(tray_handle, tray_status_clone).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            sync_now,
            cancel_sync,
            get_config,
            set_device_name,
            set_sync_interval,
            set_presence_interval,
            set_dob,
            set_allow_surplus_banking,
            scan_devices,
            get_autostart,
            set_autostart,
            get_alarm,
            set_alarm,
            clear_alarm,
            ring_strap,
            get_sleep_snapshot,
            get_daily_snapshot,
            get_sleep_history,
            start_live_stream,
            stop_live_stream,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
