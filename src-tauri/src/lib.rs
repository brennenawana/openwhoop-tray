use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use chrono::{Local, NaiveDateTime, Timelike};
use openwhoop::{OpenWhoop, WhoopDevice};
use openwhoop_algos::{SleepConsistencyAnalyzer, SleepCycle};
use openwhoop_codec::{WhoopPacket, constants::WHOOP_SERVICE};
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
use tokio::sync::RwLock;

// ---------------------------------------------------------------- config

#[derive(Serialize, Deserialize, Default, Clone)]
struct Config {
    device_name: Option<String>,
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
}

#[derive(Serialize, Clone, Copy)]
struct BatteryInfo {
    percent: f32,
    charging: bool,
    is_worn: bool,
    updated_at: NaiveDateTime,
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
    build_snapshot(&db, battery).await.map_err(|e| e.to_string())
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

    let mut cfg = state.config.write().await;
    cfg.device_name = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    cfg.save(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    do_sync(app).await.map_err(|e| e.to_string())
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
    let start = Instant::now();
    let before = heart_rate::Entity::find().count(db.connection()).await? as usize;

    emit_progress(app, "scanning");
    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No Bluetooth adapter found"))?;

    let peripheral = scan_for_device(&adapter, &device_name).await?;

    emit_progress(app, "connecting");
    let mut device = WhoopDevice::new(peripheral, adapter, db.clone(), false);
    device.connect().await?;
    device.initialize().await?;

    emit_progress(app, "downloading");
    let should_exit = Arc::new(AtomicBool::new(false));
    device.sync_history(should_exit).await?;

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
        match do_sync(app.clone()).await {
            Ok(report) => {
                let _ = app.emit("sync:complete", report);
            }
            Err(e) => {
                let _ = app.emit("sync:error", e.to_string());
            }
        }
    });
}

// ---------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: RwLock::new(None),
            db_path: RwLock::new(None),
            config: RwLock::new(Config::default()),
            config_path: RwLock::new(None),
            battery: RwLock::new(None),
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            sync_now,
            get_config,
            set_device_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
