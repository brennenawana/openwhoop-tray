# OpenWhoop Technical Reference — For Feature Ideation

This document describes the OpenWhoop system in enough detail for reasoning about new features, improved algorithms, and untapped data. It covers what data is available, how it's collected, what's already computed, and what's left on the table.

## System overview

OpenWhoop is a local-first WHOOP strap companion. It connects to a WHOOP 4.0 or 5.0 over BLE (Gen4 and Gen5 service UUIDs), downloads raw sensor + heart-rate history, stores it in SQLite, and runs community-built algorithms to derive sleep (including stage-level hypnogram, sleep need/debt, and a multi-component performance score), recovery, daytime HRV, stress, strain, SpO₂, skin temperature, activity classification, and wear periods. There is no cloud dependency. There is also a macOS Tauri tray app that wraps the same library with a GUI, background scheduler, and presence detection.

---

## What the strap records (per second)

Every ~1 second the strap records a sample. Each sample is stored as one `heart_rate` row with these fields:

| Field | Type | Source | What it is |
|---|---|---|---|
| bpm | i16 | Firmware HR estimate | Heart rate in beats per minute, computed on-device from PPG |
| rr_intervals | String (CSV of u16 ms) | Firmware beat detection | Beat-to-beat interval timing in milliseconds. Multiple RR values per second possible. This is the raw HRV input. |
| sensor_data | JSON (nullable) | Raw ADC from V12/V24 packets | Contains 12 sensor channels — see below |
| imu_data | JSON array (nullable) | Raw IMU from V12/V24 packets | 6-axis accelerometer + gyroscope samples — see below |

### sensor_data fields (SensorData struct)

| Field | Type | What it measures |
|---|---|---|
| ppg_green | u16 | Green LED photoplethysmography ADC — primary HR signal channel |
| ppg_red_ir | u16 | Red/IR LED PPG ADC — secondary channel |
| spo2_red | u16 | Red LED SpO₂ raw ADC — absorption by oxygenated hemoglobin |
| spo2_ir | u16 | Infrared LED SpO₂ raw ADC — absorption by deoxygenated hemoglobin |
| skin_temp_raw | u16 | Thermistor ADC — raw wrist skin temperature |
| ambient_light | u16 | Ambient light sensor — background light contamination |
| led_drive_1 | u16 | LED current drive setting for channel 1 |
| led_drive_2 | u16 | LED current drive setting for channel 2 |
| resp_rate_raw | u16 | Respiratory rate raw — meaning not fully understood |
| signal_quality | u16 | Signal quality index — meaning not fully documented |
| skin_contact | u8 | 0 = off-wrist, 1 = on-wrist (capacitive sense) |
| accel_gravity | [f32; 3] | Gravity direction vector [x, y, z] in g units. Tells you which way "down" is relative to the strap, which means wrist orientation. Magnitude ≈ 1.0 when stationary. |

### imu_data fields (ImuSample struct, array per row)

| Field | Type | Unit |
|---|---|---|
| acc_x_g | f32 | Acceleration in g (gravitational) |
| acc_y_g | f32 | g |
| acc_z_g | f32 | g |
| gyr_x_dps | f32 | Rotation in degrees/second |
| gyr_y_dps | f32 | dps |
| gyr_z_dps | f32 | dps |

Multiple IMU samples can exist per heart_rate row (higher sample rate than HR).

---

## What's already computed — algorithms and their limits

### Stress — Baevsky's Stress Index
- **Input**: Sliding window of 120 consecutive RR intervals
- **Method**: Build a histogram of RR intervals with 50ms bins, find the mode (most common bin), compute Baevsky's formula: `(amplitude_of_mode / (2 × variation_range × mode_value)) × 100`. Clamped to 0–10 scale.
- **Stored at**: `heart_rate.stress` (f64)
- **Known limits**: Requires 120 samples (~2 minutes at rest). Falls back to BPM-derived synthetic RR when actual intervals are sparse. The 50ms bin width is a hardcoded constant. Zero variability (constant RR) maps to maximum stress (10.0), which is mathematically correct but may surprise users.

### SpO₂ — Beer-Lambert PPG Ratio
- **Input**: Sliding window of 30 sensor readings (spo2_red + spo2_ir)
- **Method**: Compute AC component (stddev) and DC component (mean) for both red and IR channels. R = (AC_red/DC_red) / (AC_ir/DC_ir). SpO₂ = 110 − 25R. Clamped to 70–100%.
- **Stored at**: `heart_rate.spo2` (f64, percentage)
- **Known limits**: The `110 − 25R` linear formula is a textbook approximation. Real pulse oximeters use per-device calibration curves. Current implementation rejects windows where either AC amplitude < 0.001 (no pulsatile signal). In practice, ~96% of windows fail validation and return None — only 4% of samples get an SpO₂ value. Reported values run systematically low (~82% observed vs ~97% reference from a finger oximeter).

### Skin temperature
- **Input**: Single `skin_temp_raw` value per row
- **Method**: `temp_celsius = raw × 0.04`. That's it — a linear scaling factor.
- **Stored at**: `heart_rate.skin_temp` (f64, Celsius)
- **Known limits**: The 0.04 constant was empirically derived from firmware analysis and produces "physiologically reasonable" wrist temps (31–37°C) across the observed raw range (582–1125). However, WHOOP's firmware comment says "the server performs per-device calibrated conversion." Our linear formula overshoots by ~2–3°C compared to measured core temperature (38.1°C wrist vs 36.8°C armpit in one test). Raw values < 100 are rejected as off-wrist/error.

### Sleep detection — gravity stillness
- **Input**: `accel_gravity` vectors from sensor_data over time
- **Method**: Compute Euclidean distance between consecutive gravity vectors (measures how much the wrist orientation changed). A reading is "still" if delta < 0.01g. Apply a 15-minute rolling window: if ≥70% of readings in the window are still, classify as sleep. Merge runs shorter than 15 minutes into their neighbors. Only emit sleep periods ≥60 minutes.
- **Stored at**: `activities` table (type = Sleep) and `sleep_cycles` (one row per detected night)
- **Known limits**: Pure accelerometer-based *at the detection step*. Sleep *staging* is a separate pass (below) that layers HR/HRV/respiratory rate on top. Readings without gravity data default to `f32::MAX` delta (always "active"). 60-minute minimum hides sub-hour naps.

### Sleep staging — rule-v2 hierarchical classifier
- **Input**: 30-second epochs over a detected sleep cycle. Per-epoch features: HR mean/std/min/max, RMSSD, SDNN, pNN50, LF/HF power + LF/HF ratio, motion activity count, stillness ratio, respiratory rate. Per-user adaptive baseline (resting HR, sleep RMSSD median/p25/p75, HF power median, LF/HF median, respiratory rate mean/std) rolls up over 28 nights; "mature" at ≥14 nights, falls back to population defaults otherwise.
- **Method**: Hierarchical rules with within-night percentile gates (self-normalizing per night) over absolute-threshold branches anchored on the per-user baseline:
  1. **Wake**: motion_activity_count > 20 AND HR > resting + 15
  2. **Deep**: stillness ≥ 0.95 AND HR < within-night p25 (fallback: HR < resting + 8) AND RMSSD > within-night p50 (fallback: > baseline median) AND HF_power > within-night p50 AND relative_night_position ≤ 0.6
  3. **REM**: stillness ≥ 0.85 AND LF/HF > within-night p50 AND HR_std > within-night p50 AND relative_night_position ≥ 0.2
  4. **Light**: stillness ≥ 0.70 (fallthrough)
  5. Anything else → Wake
- **Post-processing**: forbidden-transition fixups (Wake/REM → Deep becomes Light); 3-epoch median filter; min-duration merge.
- **Stored at**: `sleep_epochs` table (one row per 30 s epoch, with all features for debugging). Totals, latency, WASO, efficiency, cycle count, and wake-event count land on `sleep_cycles`. User baselines go in `user_baselines` (one row per recompute).
- **Version tag**: `CLASSIFIER_VERSION = "rule-v2"`. Previous `rule-v1` used absolute `HR < resting + 8` instead of the within-night p25 — abandoned because baseline resting HR is itself derived from nightly min_bpm, making the gate tautological.
- **Known limits**: Rule-based, not model-based (no Apple-style LSTM). Respiratory rate is computed but suppressed when mean HR > 100 BPM. No accommodation for altitude, irregular rhythm, or sleep-stage-affecting medication.

### Sleep need, debt, and performance score — WHOOP-aligned
- **Input**: last 28 nights of sleep cycles; today's strain; recent naps.
- **Need formula**: `need = base_need + strain_adj + debt_adj − nap_credit − surplus_credit (if enabled)`, clamped to [4, 11] h. Constants (from `src/openwhoop-algos/src/sleep_staging/constants.rs`):
  - `BASE_NEED_HOURS = 7.5` (population default, replaced by personalized 28-night baseline once ≥14 "baseline-eligible" nights exist: strain ≤ 10, efficiency ≥ 85%, duration ≥ 6 h, nap-free)
  - `strain_adj_min = 0.3 × strain + 6.0 × max(0, strain − 10)^1.35`, capped at 90 minutes
  - `debt_adj = 0.5 × (decay-weighted 7-day deficit)`, capped at 2.0 hours
  - `nap_credit = nap_minutes × 1.0 / 60` (full credit, matching WHOOP's Locker copy). Naps ending within 120 minutes of bedtime are excluded.
  - `surplus_credit = 7-day surplus × 0.25`, capped at 0.5 h. Gated by the `allow_surplus_banking` flag (default off — WHOOP doesn't expose banking either).
- **Performance score**: combines sufficiency (got/need), efficiency (asleep/in-bed), restorative (% Deep+REM), consistency (bedtime/wake-time CV), and a sleep-stress penalty. Persisted on `sleep_cycles.performance_score`; also written to `sleep_cycles.score` for backward compat.
- **StageSleepOptions**: `allow_surplus_banking: bool` (the only option) is threaded through from tray config (`set_allow_surplus_banking` Tauri command) to `stage_sleep_with_opts`.
- **Known limits**: Coefficients are grounded in the WHOOP patent (US20240252121A1) and cited sleep-science literature (Hirshkowitz 2015, Van Dongen 2003, Belenky 2003, Rupp 2009), not reverse-engineered from WHOOP binaries. Won't match WHOOP's app number exactly. Early-user blending (linear ramp toward 7.5 h until 14 eligible nights) is OpenWhoop-specific; WHOOP doesn't document its cold-start behavior.

### Recovery score — z-scored against 14-night baseline
- **Input**: today's HRV (RMSSD), resting HR, avg respiratory rate (optional), sleep performance score (optional), skin temp deviation in °C (optional). Baseline = last 14 eligible nights.
- **Method**: z-score each metric against baseline. Weighted sum with weights HRV 0.40, RHR 0.25, sleep 0.20, respiratory rate 0.10, skin temp 0.05. Map to 0–100: `score = 50 + 15 × z_weighted`, clamped to [0, 100]. Returns `None` with <3 baseline nights.
- **Bands**: 0–33 red, 34–66 yellow, 67–100 green.
- **Output fields**: score, band, dominant_driver (which metric contributed most negatively), per-metric z-scores, baseline_window_nights, `calibrating: bool` (true while window < 14).
- **Also exposed**: age-normed HRV score (0–100) against published population norms — the Latest Sleep card shows this alongside the raw RMSSD when a DOB is configured (`set_dob` Tauri command).
- **Known limits**: Weights are hand-picked (no model fit). Skin-temp deviation input path is wired but the sensor's absolute calibration is still the limit from the skin_temp section below.

### Daytime HRV
- **Input**: RR intervals from `heart_rate.rr_intervals` outside detected sleep and wear gaps.
- **Method**: Aligned 5-minute windows (`:00, :05, :10, …` local time). Per window, require ≥3 min of coverage, ≥50 RR samples, and <30% ectopic rejection ratio (ectopic = |ΔRR| > 20% of the prior RR). Compute RMSSD + SDNN on the cleaned series. Classify context as `resting` / `active` / `mixed` based on mean HR vs. per-user resting HR and the window's stillness ratio; samples with mean HR > 100 BPM are forced to `active` or dropped.
- **Stored at**: `hrv_samples` table. The sync pipeline chunks the backlog into 24 h slices so large catch-up syncs don't blow memory.
- **Known limits**: Rejects most non-wear windows *after* gating, so noisy early wear sessions can surface spurious samples. No frequency-domain (LF/HF) features on the daytime path — only time-domain RMSSD/SDNN. Dedup runs on each pipeline pass to drop duplicate windows on re-sync.

### Activity classifier — 1-minute window with gravity fallback
- **Input**: 1-minute windows. Primary path uses 26 Hz IMU samples (accel magnitude mean/std, gyro magnitude mean, FFT dominant frequency). Fallback path triggers when a window has <10 s of IMU and reads the 1 Hz `sensor_data.accel_gravity` vector instead.
- **Classes**: Sedentary / Light / Moderate / Vigorous / Unknown.
- **IMU thresholds**: accel_std < 0.05 & gyro_mean < 10 → Sedentary; dom_hz > 3 or accel_std > 0.4 → Vigorous; moderate freq band with accel_std > 0.15 → Moderate; else Light or Unknown.
- **Gravity-fallback thresholds**: grav_Δ_mean < 0.10 g → Sed; <0.25 g → Light; ≥0.40 g with HR ≥ 120 (or HR ≥ 130 alone with Δ ≥ 0.08 g) → Vigorous; HR ≥ 95 bridges to Moderate.
- **Stored at**: `activity_samples` (per-minute rows with the features used). Downstream aggregation into the `activities` table applies workout filtering (min/max durations, exclusion of Active-wake transitions); the per-minute classifier itself imposes no duration cap.
- **Known limits**: Firmware doesn't ship gyro at 1 Hz, so the gravity-fallback path fills the gyro field with 0.0 as a flag. No activity-type recognition (running vs. cycling vs. lifting) — only intensity bucketing.

### Wear periods — events + skin-contact fusion
- **Input**: strap-pushed `WristOn` / `WristOff` events (from the new `events` table), plus `heart_rate.sensor_data.skin_contact` per-sample flag.
- **Method**: Events are authoritative when present; skin_contact runs (contiguous `skin_contact = 1` samples, merged across gaps ≤ 60 s) fill the gaps and close dangling WristOn at the last seen skin_contact sample. Periods < 5 minutes are dropped.
- **Stored at**: `wear_periods` table, tagged with `source = events | skin_contact | fused`.
- **Known limits**: Orphan WristOff (no prior WristOn) falls back to the earliest nearby skin_contact run, which can misplace the start by up to a minute. Pre-sync data collected before WristOn event persistence landed relies entirely on skin_contact.

### Sleep consistency
- **Input**: Array of SleepCycle records across multiple nights
- **Method**: Compute mean and standard deviation of: sleep duration, bedtime, wake time, and sleep midpoint. Duration score = 100 − coefficient_of_variation. Timing score = mean of 3 timing CVs. Overall = mean(duration_score, timing_score).
- **Output**: ConsistencyScore { total_score, duration_score, timing_score } (0–100)
- **Known limits**: CV-based, so a single outlier night can tank the score. Does not factor in chronotype or circadian rhythm.

### Strain — Edwards' TRIMP
- **Input**: 600+ HR readings (~10 minutes at 1Hz), plus max_hr and resting_hr
- **Method**: Compute Heart Rate Reserve (HRR = max − resting). Classify each BPM sample into zone 1–5 based on %HRR. TRIMP = sum(sample_duration_minutes × zone_weight). Strain = 21 × ln(TRIMP + 1) / ln(7201).
- **Output**: StrainScore (f64, 0–21 scale)
- **Known limits**: Zone boundaries are 50/60/70/80/90% HRR — fixed, no per-user adaptation. max_hr is derived from observed data (or defaulted to 180), not from a max-HR test. Resting HR comes from the latest sleep's min_bpm. If sleep hasn't been detected, strain cannot be computed. A full day at max HR maps to strain 21.0 (calibration anchor).

### HRV (sleep) — RMSSD
- **Input**: RR intervals from heart_rate rows during a detected sleep period.
- **Method**: Sliding window of 300 consecutive RR values. For each window, compute RMSSD. Store min/avg/max across all windows in the sleep cycle. The rule-v2 staging pass re-derives per-30s-epoch RMSSD/SDNN/pNN50 alongside LF/HF spectral features and persists them on `sleep_epochs` for debugging.
- **Stored at**: `sleep_cycles.{min_hrv, avg_hrv, max_hrv}`; per-epoch in `sleep_epochs`.
- **Known limits**: Sleep RMSSD is still summarized to three numbers on `sleep_cycles`. No full-night LF/HF ratio rollup column — consumers have to read `sleep_epochs` for spectral data.

---

## BLE protocol — what's implemented vs. available

The strap communicates over a custom BLE service. All commands go through a single write characteristic (CMD_TO_STRAP) and responses come back on CMD_FROM_STRAP. Packets are framed: `[0xAA][LEN_LE][CRC8][TYPE|SEQ|CMD|DATA][CRC32]`.

Gen4 and Gen5 straps use different service + characteristic UUIDs (see "Firmware context" below) and slightly different packet framing — the codec provides parallel sets (`CMD_TO_STRAP_GEN4` / `CMD_TO_STRAP_GEN5`, etc.). The command IDs and event IDs below are the same across generations.

### Implemented commands (have packet constructors + response parsers)

| ID | Name | What it does |
|---|---|---|
| 1 | LinkValid | Initial handshake |
| 7 | ReportVersionInfo | Returns Harvard + Boylston firmware version strings |
| 10 | SetClock | Sets the strap's wall clock to UTC |
| 22 | SendHistoricalData | Starts historical data streaming |
| 23 | HistoricalDataResult | ACK for history chunks (includes trim pointer) |
| 26 | GetBatteryLevel | Returns battery % as uint16_le/10.0 |
| 35 | GetHelloHarvard | Returns large status struct: byte 7 = charging, byte 116 = is_worn |
| 66 | SetAlarmTime | Sets a future alarm (enabled=1, unix timestamp) |
| 67 | GetAlarmTime | Returns current alarm state (enabled, unix) |
| 68 | RunAlarm | Triggers immediate haptic buzz (find-my-device) |
| 69 | DisableAlarm | Clears a set alarm |
| 96 | EnterHighFreqSync | Requests faster data transfer mode |
| 97 | ExitHighFreqSync | Returns to normal mode |

### Available but NOT implemented (enum values exist, no parser)

| ID | Name | Potential use |
|---|---|---|
| 3 | ToggleRealtimeHr | Enable live HR streaming (~10 Hz updates via PacketType 0x28) |
| 11 | GetClock | Read the strap's current time |
| 14 | ToggleGenericHrProfile | Enable standard BLE HR service (so other apps can read HR) |
| 29 | RebootStrap | Remote reboot |
| 32 | PowerCycleStrap | Hard power cycle |
| 36–38 | Firmware load/process | OTA firmware update pipeline (3 commands) |
| 39 | SetLedDrive | Change LED brightness/power |
| 79 | RunHapticsPattern | Custom vibration pattern |
| 84 | GetBodyLocationAndStatus | Detailed body placement info |
| 98 | GetExtendedBatteryInfo | Extended battery telemetry (temp, health, cycles?) |
| 99 | ResetFuelGauge | Battery fuel gauge recalibration |
| 105 | ToggleImuModeHistorical | Enable/disable IMU in history packets |
| 106 | ToggleImuMode | Enable/disable IMU for current session |
| 107 | EnableOpticalData | Enable raw optical sensor data stream |
| 108 | ToggleOpticalMode | Switch optical sensing modes |
| 123 | SelectWrist | Inform the strap which wrist it's on |

### Event types (pushed by strap on EVENTS_FROM_STRAP)

The strap pushes unsolicited events. Currently these are parsed but mostly ignored (the handler is `WhoopData::Event { .. } => {}`). Known event IDs:

| ID | Name |
|---|---|
| 3 | BatteryLevel |
| 5 | External5vOn |
| 6 | External5vOff |
| 7 | ChargingOn |
| 8 | ChargingOff |
| 9 | WristOn |
| 10 | WristOff |
| 14 | DoubleTap |
| 63 | ExtendedBatteryInformation |
| 96 | HighFreqSyncPrompt |

---

## What the tray app exposes to the UI

The tray app backend caches derived state and serves it via several Tauri commands (see `src-tauri/src/lib.rs`). The three snapshot commands:

### `get_snapshot` → `Snapshot`
The always-on home-view payload.
- **today**: sample_count, last_seen, current_bpm, min/avg/max bpm, latest stress/spo2/skin_temp, hourly_bpm[24], **hr_series** (raw 24 h `Vec<(time, bpm)>` so the frontend can re-bin at any time scale)
- **latest_sleep**: night label, start/end, duration_minutes, score, min/avg/max bpm, min/avg/max hrv
- **recovery** (Option): score (0–100), band (red/yellow/green), dominant_driver (hrv/rhr/sleep/rr/skin_temp/none), for_sleep_id, baseline_window_nights, calibrating, per-metric z-scores (z_hrv/z_rhr/z_sleep/z_rr/z_skin_temp), hrv_rmssd_ms, age_normed_hrv_score
- **week**: sleep_nights, avg_sleep_duration_minutes, avg_sleep_score, consistency_score, workout_count, workout_total_minutes
- **recent_activities**: last 5 workouts with start/end/duration
- **battery**: percent, charging, is_worn, updated_at — plus **battery_estimate** (hours-remaining prediction from `battery_log` drain curve)
- **alarm**: enabled, at
- **sync state**: last_sync_at, last_sync_attempt_at, next_sync_at, sync_in_progress, strap_seen_at

### `get_sleep_snapshot` → `Option<SleepSnapshot>`
The hypnogram modal's payload. Re-computed from `sleep_cycles` + `sleep_epochs` on every call (sub-millisecond for a typical ~960-epoch night).
- sleep_start, sleep_end
- stages: awake_min, light_min, deep_min, rem_min
- hypnogram: `Vec<{start, end, stage}>` quantized to 1-minute resolution
- efficiency, latency_min, waso_min, cycle_count, wake_event_count
- avg_respiratory_rate, skin_temp_deviation_c
- performance_score, sleep_need_hours, sleep_debt_hours
- score_components: sufficiency, efficiency, restorative, consistency, sleep_stress
- classifier_version, baseline_window_nights

### `get_daily_snapshot` → `DailySnapshot`
The Today card's payload. Fail-soft per source — a failed query substitutes empty/None rather than short-circuiting.
- day_start, generated_at
- today_wear_minutes (summed from wear_periods)
- today_hrv_samples: `Vec<{window_start, window_end, rmssd, mean_hr, context}>`
- today_activity_breakdown: sedentary/light/moderate/vigorous/unknown minutes
- recent_events: timestamp, event_id, event_name from the events table
- device_info: latest harvard/boylston firmware + device name
- alarm_history
- recent_sync_log: outcome + row counts per sync attempt

### `get_sleep_history` → `SleepHistory`
14-night (configurable, server-clamped) rollup of sleep cycles + per-day wear / daytime HRV / activity breakdown. Phase 3.1 History page.

### Other Tauri commands
`sync_now`, `cancel_sync`, `get_alarm`/`set_alarm`/`clear_alarm`, `ring_strap`, `start_live_stream`/`stop_live_stream` (Gen4-only — Gen5 is gated off), `scan_devices`, `get_autostart`/`set_autostart`, `get_config`, `set_device_name`, `set_sync_interval`, `set_presence_interval`, `set_dob`, `set_allow_surplus_banking`.

### Background tasks running in the tray app

Three long-lived tokio tasks spawn at startup (see `lib.rs` `run()` ~line 2190):

| Task | Frequency | Purpose |
|---|---|---|
| Scheduler loop | Config-driven (`sync_interval_minutes`: manual / 15m / 1h / 4h / daily) | Immediate sync on startup if a device is configured, then sleeps until the next interval or a `scheduler_notify` wake (device name / interval changed). Uses `last_sync_attempt_at` to advance even on failure. |
| Presence loop | Config-driven (`presence_interval_minutes`: off / 1m / 2m / 5m / 10m) | ~8-second BLE scan; updates `strap_seen_at`; triggers an immediate sync on absent→present transition. |
| Tray update loop | Every 10 seconds | Refreshes tray menu status item and tooltip with battery / presence / sync status. |

Within a single sync attempt, two scoped watchdogs run via `AbortOnDrop` spawns:

| Guard | Trigger | Effect |
|---|---|---|
| Hard-timeout | `SYNC_TIMEOUT = 900 s` (15 minutes) | Sets `CancelReason::HardTimeout`; user sees "Sync taking too long." |
| Progress watchdog | Polls `heart_rate` row count every 3 s; also polls `peripheral.is_connected()` every 3 s (with 2 s per-poll timeout) | No new rows for 30 s → `CancelReason::NoProgress`. BLE disconnect detected → same. Replaced the old 5-minute-hang-on-disconnect failure mode (commit 8728fab, 2026-04-23). |
| User cancel | `cancel_sync` Tauri command | `CancelReason::User`. |

---

## Raw data not currently used by any algorithm

These fields are collected and stored but no algorithm reads them:

| Field | Where stored | What it could reveal |
|---|---|---|
| ppg_green | sensor_data.ppg_green | Raw green-channel PPG waveform — could reconstruct pulse waveform, compute pulse transit time, detect arrhythmias |
| ppg_red_ir | sensor_data.ppg_red_ir | Secondary PPG channel — could improve SpO₂ accuracy with a per-device calibration model |
| ambient_light | sensor_data.ambient_light | Background light contamination — could be used to quality-gate other optical readings |
| led_drive_1, led_drive_2 | sensor_data | Current settings for LEDs — could normalize PPG readings for intensity |
| resp_rate_raw | sensor_data.resp_rate_raw | Respiratory rate — the strap has a raw signal but we have no parser or algorithm for it |
| signal_quality | sensor_data.signal_quality | Quality index from firmware — could be used to weight or reject low-quality samples |
| gyr_x/y/z_dps | imu_data | Gyroscope — wrist rotation rate. Currently unused. Could detect specific activities (typing, running cadence, gestures) |
| Full accelerometer time series | imu_data (array) | Multiple IMU samples per HR row — higher temporal resolution than the 1Hz gravity vector. Could compute step count, activity intensity, tremor detection |
| skin_contact | sensor_data.skin_contact | On/off wrist flag from capacitive sensor — currently only surfaced via GetHelloHarvard command, not from the per-sample field |

---

## Database schema reference

### heart_rate
Primary data table. One row per ~1 second of wear time.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | i32 | NO | Auto-increment PK |
| bpm | i16 | NO | Firmware-computed heart rate |
| time | DateTime | NO | Unique, indexed |
| rr_intervals | String | NO | Comma-separated u16 ms values |
| activity | i64 | YES | Activity classification (firmware-assigned) |
| stress | f64 | YES | Baevsky stress index (0–10), computed post-hoc |
| spo2 | f64 | YES | Blood oxygen %, computed post-hoc |
| skin_temp | f64 | YES | Celsius, computed post-hoc |
| imu_data | JSON | YES | Array of ImuSample |
| sensor_data | JSON | YES | SensorData struct |
| synced | bool | NO | Remote sync flag |

### sleep_cycles
One row per detected sleep night.

| Column | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| sleep_id | Date | Unique — the "night of" date |
| start / end | DateTime | Sleep boundaries |
| min/max/avg_bpm | i16 | HR stats during sleep |
| min/max/avg_hrv | i32 | RMSSD HRV stats (300-sample rolling) |
| score | f64 | Persisted as `performance_score` for backward compat |
| awake/light/deep/rem_minutes | f64 | Stage totals from rule-v2 classifier |
| sleep_latency_minutes | f64 | Time to fall asleep |
| waso_minutes | f64 | Wake after sleep onset |
| sleep_efficiency | f64 | Asleep / in-bed (0–1) |
| wake_event_count / cycle_count | i32 | Wake micro-arousals, sleep cycle count |
| avg/min/max_respiratory_rate | f64 | Breaths per minute during sleep |
| skin_temp_deviation_c | f64 | Δ vs. per-user skin-temp baseline |
| sleep_need_hours / sleep_debt_hours | f64 | Need formula output + 7-day decay-weighted deficit |
| performance_score | f64 | Multi-component sleep score (0–100) |
| classifier_version | String | e.g. `rule-v2` |
| synced | bool | Remote sync flag |

### sleep_epochs
One row per 30-second sleep epoch, written by the rule-v2 classifier.

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| sleep_cycle_id | UUID | FK → sleep_cycles.id (cascade) |
| epoch_start / epoch_end | DateTime | 30-second boundaries |
| stage | String | Wake / Light / Deep / REM / Unknown |
| confidence | f64 nullable | Reserved — not populated by rule-based classifier |
| hr_mean/std/min/max | f64 | Per-epoch HR stats |
| rmssd / sdnn / pnn50 | f64 | Time-domain HRV |
| lf_power / hf_power / lf_hf_ratio | f64 | Frequency-domain HRV |
| motion_activity_count / motion_stillness_ratio | f64 | From 1 Hz gravity vector |
| resp_rate | f64 | Breaths per minute |
| feature_blob | JSON | Debug bag (version-tolerant) |
| classifier_version | String | Which classifier produced this row |

### user_baselines
Rolling per-user thresholds. Latest row by `computed_at` is the active baseline.

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| computed_at | DateTime | When this baseline was built |
| window_nights | i32 | Number of eligible nights (< 14 = "calibrating") |
| resting_hr | f64 | From baseline-eligible sleep min HR |
| sleep_rmssd_median / p25 / p75 | f64 | RMSSD distribution |
| hf_power_median / lf_hf_ratio_median | f64 | Spectral baselines |
| sleep_duration_mean_hours | f64 | For need-formula baseline term |
| respiratory_rate_mean / std | f64 | Baseline breathing |
| skin_temp_mean_c / std_c | f64 | Baseline skin temperature |

### activities
One row per aggregated activity period (downstream of activity_samples).

| Column | Type | Notes |
|---|---|---|
| id | i32 | Auto-increment PK |
| period_id | Date | FK → sleep_cycles.sleep_id |
| start / end | DateTime | Activity boundaries |
| activity | String | "Activity", "Running", "Nap", etc. |
| synced | bool | |

### activity_samples
Per-minute rows from the activity classifier (feeds the DailySnapshot activity breakdown).

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| window_start / window_end | DateTime | 1-minute boundaries |
| classification | String | sedentary / light / moderate / vigorous / unknown |
| accel_magnitude_mean / std | f64 | IMU path; gravity-fallback path uses Δ-gravity mean |
| gyro_magnitude_mean | f64 | 0.0 on the gravity-fallback path |
| dominant_frequency_hz | f64 | FFT dominant frequency (IMU path) |
| mean_hr | f64 | Mean BPM in window |

### hrv_samples
Daytime HRV windows.

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| window_start / window_end | DateTime | 5-minute boundaries, aligned to :00, :05, :10, ... |
| rmssd | f64 | Time-domain HRV (ms) |
| sdnn | f64 nullable | Standard deviation of NN intervals |
| mean_hr | f64 | Mean BPM |
| rr_count | i32 | Clean RR intervals in window |
| stillness_ratio | f64 | Fraction of window stationary |
| context | String | resting / active / mixed |

### wear_periods
Contiguous on-wrist intervals derived from WristOn/WristOff events + skin_contact fallback.

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| start / end | DateTime | Wear boundaries |
| source | String | events / skin_contact / fused |
| duration_minutes | f64 | Cached for fast sum |

### events
WristOn/WristOff, charging, double-tap, etc. — strap-pushed event log.

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| timestamp | DateTime | |
| event_id | i32 | See "Event types" table below |
| event_name | String | Human-readable |
| raw_data | JSON nullable | Event payload |
| synced | bool | |

Unique index on (timestamp, event_id) so re-syncs idempotently dedup.

### device_info
Firmware version + device name history (one row per recorded sync).

| Column | Type |
|---|---|
| id | i32 |
| recorded_at | DateTime |
| harvard_version / boylston_version | String nullable |
| device_name | String nullable |

### alarm_history
Every set/clear/fire of the strap alarm.

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| action | String | e.g. "set", "clear", "fired" |
| action_at | DateTime | When the tray observed the action |
| scheduled_for | DateTime nullable | The alarm's target time |
| enabled | bool nullable | |

### battery_log
Battery-level telemetry for the drain-curve estimator.

| Column | Type |
|---|---|
| id | i32 |
| time | DateTime |
| percent | f64 |
| charging | bool |
| is_worn | bool |
| avg_bpm | i16 nullable |

### sync_log
Per-sync-attempt outcome log (powers Today card's "recent syncs" list).

| Column | Type | Notes |
|---|---|---|
| id | i32 | PK |
| attempt_started_at | DateTime | |
| attempt_ended_at | DateTime nullable | |
| outcome | String | success / failure / cancelled |
| error_message | String nullable | |
| heart_rate_rows_added / packets_downloaded / sleep_cycles_created | i32 | |
| trigger | String nullable | "scheduler", "manual", "presence", ... |

### dev_notes
Dashboard/agent-dev notes table (populated by the `openwhoop note` CLI).

| Column | Type |
|---|---|
| id | i32 |
| created_at | DateTime |
| author / kind / title | String |
| body_md | String nullable |
| related_commit / related_feature | String nullable |
| related_range_start / related_range_end | DateTime nullable |
| resolved_at / resolved_by | String nullable |
| payload_json | JSON nullable |

### packets
Raw BLE packets — the source-of-truth archive.

| Column | Type | Notes |
|---|---|---|
| id | i32 | Auto-increment PK |
| uuid | UUID | BLE characteristic UUID |
| bytes | Blob | Raw packet bytes, framed |

---

## Data received but NOT captured

The strap sends significantly more data than we currently store. This section catalogs every known gap.

### EVENTS_FROM_STRAP — now persisted

The strap pushes event notifications on the EVENTS_FROM_STRAP characteristic (both Gen4 and Gen5 have their own UUID for this). Events are parsed into `Event { unix, event }` or `UnknownEvent { unix, event }` variants of `WhoopData`. As of migration `m20260417_000000_events`, they are persisted to the `events` table with a unique (timestamp, event_id) index so re-syncs dedup. The following events are routed:

| Event ID | Name | What it signals |
|---|---|---|
| 3 | BatteryLevel | Battery percentage changed |
| 5 | External5vOn | External power connected |
| 6 | External5vOff | External power disconnected |
| 7 | ChargingOn | Charging started |
| 8 | ChargingOff | Charging stopped |
| 9 | WristOn | Strap placed on wrist (consumed by wear-period detection) |
| 10 | WristOff | Strap removed from wrist (consumed by wear-period detection) |
| 14 | DoubleTap | User double-tapped the strap |
| 63 | ExtendedBatteryInformation | Extended battery telemetry |
| 96 | HighFreqSyncPrompt | Strap requesting high-frequency sync |

`RunAlarm { unix }` and `AlarmInfo { enabled, unix }` land in the `alarm_history` table. `VersionInfo { harvard, boylston }` seen at init-time is written to `device_info`. `ConsoleLog { unix, log }` is still only emitted via `trace!` — not persisted.

### Packet types with no parser (silently dropped)

These `PacketType` variants are defined in the codec but `from_packet()` has no match arm — they fall through to `Err(Unimplemented)` and are silently caught in `handle_packet`.

| PacketType | Hex | What it carries |
|---|---|---|
| RealtimeData | 0x28 | Live HR at ~10Hz when ToggleRealtimeHr (cmd 3) is enabled |
| RealtimeRawData | 0x2B | Raw PPG waveform — enables respiratory rate extraction, pulse waveform analysis |
| RealtimeImuDataStream | 0x33 | Streaming 6-axis accelerometer + gyroscope |
| HistoricalImuDataStream | 0x34 | Batched historical IMU data |

### Command responses from initialize() — all dropped

During startup, four commands are sent but only two response types are handled in the `CommandResponse` match:

| Command sent | Response cmd | Handled? | What's lost |
|---|---|---|---|
| hello_harvard (35) | GetHelloHarvard (35) | ❌ falls to Unimplemented | Charging state, wrist state, device status struct |
| set_time (10) | SetClock (10) | ❌ | Confirmation the clock was set |
| get_name (76) | GetAdvertisingNameHarvard (76) | ❌ | The device's own advertising name |
| enter_high_freq_sync (96) | EnterHighFreqSync (96) | ❌ | HFS mode confirmation |

Only `ReportVersionInfo` (7) and `GetAlarmTime` (67) responses are actually parsed. The tray app added parsers for `GetBatteryLevel` (26) and `GetHelloHarvard` (35) but only for explicit on-demand reads, not for the init-time responses.

### Raw packets are conditional

The `packets` table only gets written when `debug_packets=true` (off by default). In normal operation, raw BLE wire bytes are never stored. Old sessions cannot be replayed or re-parsed if new packet handlers are added later.

### Still not persisted

- `ConsoleLog` firmware diagnostics (trace-only).
- RealtimeData / RealtimeRawData / RealtimeImuDataStream / HistoricalImuDataStream packet types (PacketType enum values exist but `from_packet()` has no match arms — silently dropped as `Err(Unimplemented)`).
- Raw BLE packets — the `packets` table still only gets written when `debug_packets=true` (off by default).

---

## Firmware context

- **Tested hardware**: WHOOP 4.0 (Gen4). WHOOP 5.0 (Gen5) discovery, handshake, and historical-data sync are supported upstream (`feat/whoop5.0-compat`, PR #23) — Gen5 advertises `WHOOP_SERVICE_GEN5 = fd4b0001-…` and uses separate CMD/DATA/EVENTS characteristic UUIDs. Live-stream (`ToggleRealtimeHr`) is Gen4-only — the tray app gates on `WhoopGeneration::Gen4` and errors out for Gen5 since Gen5 uses different packet framing (`WhoopPacket::from_data_maverick`) that the tray's live-stream path hasn't been ported to.
- **Tested firmware (Gen4)**: Harvard 41.16.6.0, Boylston 17.2.2.0
- **BLE service UUIDs**:
  - Gen4: `61080001-8d6d-82b8-614a-1c8cb0f8dcc6`
  - Gen5: `fd4b0001-cce1-4033-93ce-002d5875f58a`
  - `ALL_WHOOP_SERVICES` in `openwhoop-codec::constants` is the canonical list used by the tray scanner.
- **HistoryComplete metadata**: the `MetadataType::HistoryComplete` (value 3) is defined in the codec but the tested firmware never sends it. The strap just stops responding after the last chunk. The "caught up" detection compares the latest reading timestamp to `Utc::now()` and exits when within 60 seconds.
- **BLE standard Battery Service**: The strap exposes `0x180F` (Battery Service) with `0x2A19` (Battery Level), but it returns a stale/incorrect value (100% observed when the real level was 14.5%). The correct reading comes from the custom `GetBatteryLevel` command (ID 26).
- **Dual firmware images**: Harvard = main MCU, Boylston = BLE chip. Both versioned independently and logged to `device_info`.
