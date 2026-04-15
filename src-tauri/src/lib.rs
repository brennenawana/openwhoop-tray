use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use chrono::{Local, NaiveDateTime, TimeDelta, Timelike};
use openwhoop::{OpenWhoop, WhoopDevice};
use openwhoop_algos::{SleepConsistencyAnalyzer, SleepCycle};
use openwhoop_codec::{WhoopData, WhoopPacket, constants::WHOOP_SERVICE};
use openwhoop_db::DatabaseHandler;
use openwhoop_entities::heart_rate;
use openwhoop_types::activities::{ActivityPeriod, ActivityType, SearchActivityPeriods};
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager as _, State,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
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
    sync_cancel: Arc<AtomicBool>,
    sync_cancel_reason: Arc<RwLock<Option<CancelReason>>>,
    strap_seen_at: RwLock<Option<NaiveDateTime>>,
    ble_lock: Arc<Mutex<()>>,
    alarm: RwLock<Option<AlarmStatus>>,
}

#[derive(Serialize, Clone, Copy)]
struct BatteryInfo {
    percent: f32,
    charging: bool,
    is_worn: bool,
    updated_at: NaiveDateTime,
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
    week: WeekSection,
    recent_activities: Vec<ActivitySummary>,
    battery: Option<BatteryInfo>,
    last_sync_at: Option<NaiveDateTime>,
    last_sync_attempt_at: Option<NaiveDateTime>,
    next_sync_at: Option<NaiveDateTime>,
    sync_in_progress: bool,
    strap_seen_at: Option<NaiveDateTime>,
    alarm: Option<AlarmStatus>,
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
    build_snapshot(
        &db,
        battery,
        last_sync_at,
        last_sync_attempt_at,
        next_sync_at,
        sync_in_progress,
        strap_seen_at,
        alarm,
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
    let mut device = WhoopDevice::new(peripheral, adapter, db, false);
    device.connect().await?;

    // Apply the change. set/clear don't return useful responses, so we
    // always follow with get_alarm to confirm.
    if let AlarmOp::Set(unix) = op {
        device.send_command(WhoopPacket::alarm_time(unix)).await?;
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
    const SYNC_TIMEOUT: Duration = Duration::from_secs(300);

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
    let mut device = WhoopDevice::new(peripheral, adapter, db.clone(), false);
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

    let sync_result = device.sync_history(cancel.clone()).await;
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
    let whoop = OpenWhoop::new(db.clone());
    whoop.detect_sleeps().await?;
    whoop.detect_events().await?;
    whoop.calculate_stress().await?;
    whoop.calculate_spo2().await?;
    whoop.calculate_skin_temp().await?;

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

    Ok(Snapshot {
        generated_at: now,
        today: build_today(&today_rows),
        latest_sleep: sleep_cycles.last().map(build_sleep_section),
        week: build_week(&sleep_cycles, &recent_activities, week_start)?,
        recent_activities: build_activity_list(&recent_activities),
        battery,
        last_sync_at,
        last_sync_attempt_at,
        next_sync_at,
        sync_in_progress,
        strap_seen_at,
        alarm,
    })
}

fn build_today(rows: &[heart_rate::Model]) -> TodaySection {
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
    }
}

fn build_sleep_section(s: &SleepCycle) -> SleepSection {
    let duration = (s.end - s.start).num_minutes();
    SleepSection {
        night: s.id.format("%a %b %d").to_string(),
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

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
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
    match do_sync_guarded(app.clone()).await {
        Ok(report) => {
            let _ = app.emit("sync:complete", report);
        }
        Err(e) => {
            eprintln!("scheduled sync failed: {}", e);
            let _ = app.emit("sync:error", e.to_string());
        }
    }
}

/// Lightweight presence detector. Every 2 minutes, does a 5-second BLE scan
/// for the configured device. Updates strap_seen_at on hit. When the strap
/// transitions from absent → present, triggers an immediate sync so users
/// who left and came back don't have to wait for the next scheduled tick.
async fn presence_loop(app: AppHandle) {
    let mut last_seen = false;

    loop {
        tokio::time::sleep(Duration::from_secs(120)).await;

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
        if in_range && !last_seen {
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
            sync_cancel: Arc::new(AtomicBool::new(false)),
            sync_cancel_reason: Arc::new(RwLock::new(None)),
            strap_seen_at: RwLock::new(None),
            ble_lock: Arc::new(Mutex::new(())),
            alarm: RwLock::new(None),
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
            let show_item =
                MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
            let sync_item =
                MenuItem::with_id(app, "sync", "Sync Now", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit OpenWhoop", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&show_item, &sync_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "sync" => trigger_sync_from_tray(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        toggle_main_window(tray.app_handle());
                    }
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            sync_now,
            cancel_sync,
            get_config,
            set_device_name,
            set_sync_interval,
            scan_devices,
            get_autostart,
            set_autostart,
            get_alarm,
            set_alarm,
            clear_alarm,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
