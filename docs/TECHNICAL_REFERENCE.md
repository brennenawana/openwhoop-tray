# OpenWhoop Technical Reference — For Feature Ideation

This document describes the OpenWhoop system in enough detail for reasoning about new features, improved algorithms, and untapped data. It covers what data is available, how it's collected, what's already computed, and what's left on the table.

## System overview

OpenWhoop is a local-first WHOOP strap companion. It connects to a WHOOP 4.0 over BLE, downloads raw sensor + heart-rate history, stores it in SQLite, and runs community-built algorithms to derive sleep, stress, strain, SpO₂, and skin temperature. There is no cloud dependency. There is also a macOS Tauri tray app that wraps the same library with a GUI, background scheduler, and presence detection.

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
- **Stored at**: `activities` table (type = Sleep)
- **Known limits**: Pure accelerometer-based. Does not use heart rate, HRV, or respiratory rate for sleep staging. Cannot detect sleep stages (light/deep/REM). Readings without gravity data (older firmware packets) default to `f32::MAX` delta and are always classified as "active" — sleep detection is impossible without gravity. The 60-minute minimum means naps < 1 hour are invisible.

### Sleep scoring — duration only
- **Input**: `sleep_cycles.start` and `sleep_cycles.end`
- **Method**: `score = (duration_seconds / 28800) × 100`, clamped to 0–100. 28800 seconds = 8 hours.
- **Stored at**: `sleep_cycles.score`
- **Known limits**: This is purely duration-based. It does not consider sleep efficiency, time to fall asleep, wake-after-sleep-onset, HRV during sleep, respiratory rate, sleep stage composition, or any other quality metric. 8 hours of tossing and turning scores the same as 8 hours of deep restful sleep. The WHOOP app's real sleep score uses a multi-factor model that this does not replicate.

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

### HRV — RMSSD (computed during sleep only)
- **Input**: RR intervals from heart_rate rows during a detected sleep period
- **Method**: Sliding window of 300 consecutive RR values. For each window, compute RMSSD (root mean square of successive differences). Store min/avg/max across all windows in the sleep cycle.
- **Stored at**: `sleep_cycles.{min_hrv, avg_hrv, max_hrv}`
- **Known limits**: 300-interval window ≈ 5 minutes at resting HR. HRV is only computed during sleep — no daytime HRV. There is no standalone "calculate HRV" command; it's embedded in sleep cycle creation. No frequency-domain HRV analysis (LF/HF ratio, etc.).

---

## BLE protocol — what's implemented vs. available

The strap communicates over a custom BLE service. All commands go through a single write characteristic (CMD_TO_STRAP) and responses come back on CMD_FROM_STRAP. Packets are framed: `[0xAA][LEN_LE][CRC8][TYPE|SEQ|CMD|DATA][CRC32]`.

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

The tray app backend caches all derived state and serves it via a `get_snapshot` Tauri command. The Snapshot struct returned to the frontend contains:

- **today**: sample_count, last_seen, current_bpm, min/avg/max bpm, latest stress/spo2/skin_temp, hourly_bpm[24]
- **latest_sleep**: night label, start/end times, duration_minutes, score, min/avg/max bpm, min/avg/max hrv
- **week**: sleep_nights count, avg sleep duration, avg sleep score, consistency score, workout count, workout total minutes
- **recent_activities**: last 5 workouts with start/end/duration
- **battery**: percent (f32), charging (bool), is_worn (bool), updated_at
- **alarm**: enabled (bool), at (NaiveDateTime nullable)
- **sync state**: last_sync_at, last_sync_attempt_at, next_sync_at, sync_in_progress, strap_seen_at

### Background tasks running in the tray app

| Task | Frequency | Purpose |
|---|---|---|
| Scheduler | Configurable (manual / 15m / 1h / 4h / daily) | Runs full sync pipeline: download history → detect sleeps → detect events → calculate stress/spo2/skin_temp |
| Presence ping | Configurable (off / 1m / 2m / 5m / 10m) | Quick 5-second BLE scan; updates strap_seen_at; triggers sync on absent→present transition |
| Tray updater | Every 10 seconds | Refreshes tray menu text and tooltip with current battery / presence / sync status |
| Progress monitor | Every 3 seconds during download phase | Polls heart_rate row count; emits download progress events; fires 30-second stall detector |
| Timeout guardian | Once per sync | 5-minute hard ceiling; flips cancel flag if sync exceeds this |

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
| score | f64 | Duration-based score (0–100) |
| synced | bool | Remote sync flag |

### activities
One row per detected activity period.

| Column | Type | Notes |
|---|---|---|
| id | i32 | Auto-increment PK |
| period_id | Date | FK → sleep_cycles.sleep_id |
| start / end | DateTime | Activity boundaries |
| activity | String | "Activity", "Running", "Nap", etc. |
| synced | bool | |

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

### EVENTS_FROM_STRAP — subscribed to, but silently dropped

The code subscribes to the EVENTS_FROM_STRAP BLE characteristic during `initialize()`, so the strap pushes event notifications. However, `handle_packet` only routes notifications from DATA_FROM_STRAP and CMD_FROM_STRAP — any other UUID hits a catch-all `return Ok(None)`. All of the following real-time push events are received and discarded:

| Event ID | Name | What it signals |
|---|---|---|
| 3 | BatteryLevel | Battery percentage changed |
| 5 | External5vOn | External power connected |
| 6 | External5vOff | External power disconnected |
| 7 | ChargingOn | Charging started |
| 8 | ChargingOff | Charging stopped |
| 9 | WristOn | Strap placed on wrist |
| 10 | WristOff | Strap removed from wrist |
| 14 | DoubleTap | User double-tapped the strap |
| 63 | ExtendedBatteryInformation | Extended battery telemetry |
| 96 | HighFreqSyncPrompt | Strap requesting high-frequency sync |

**Root cause**: one-line UUID routing bug. Fixing it would unlock live state notifications without polling.

### Parsed but then ignored (no-op handlers)

These WhoopData variants are decoded successfully but matched to empty `{}` blocks in `handle_data`:

| Variant | Fields available | What's lost |
|---|---|---|
| `Event { unix, event }` | Timestamp + event type enum | Event log with classification |
| `UnknownEvent { unix, event }` | Timestamp + raw u8 event code | Unmapped events from newer firmware |
| `RunAlarm { unix }` | Timestamp when alarm fired | Alarm execution history |
| `AlarmInfo { enabled, unix }` | Enabled flag + scheduled time | Only used transiently in get_alarm(), never persisted |

### Logged but not stored

| Variant | Log level | What's lost by not persisting |
|---|---|---|
| `ConsoleLog { unix, log }` | `trace!` | Firmware diagnostic messages (sensor errors, calibration, internal state) |
| `VersionInfo { harvard, boylston }` | `info!` | No audit trail linking data to the firmware version that produced it |

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

### No database tables exist for

Events, console logs, device info/version history, alarm history, or any realtime stream data. The entire persisted schema is four tables: `packets` (conditional), `heart_rate`, `sleep_cycles`, `activities`.

---

## Firmware context

- **Tested hardware**: WHOOP 4.0
- **Firmware**: Harvard 41.16.6.0, Boylston 17.2.2.0
- **HistoryComplete metadata**: the `MetadataType::HistoryComplete` (value 3) is defined in the codec but the tested firmware never sends it. The strap just stops responding after the last chunk. The "caught up" detection compares the latest reading timestamp to `Utc::now()` and exits when within 60 seconds.
- **BLE standard Battery Service**: The strap exposes `0x180F` (Battery Service) with `0x2A19` (Battery Level), but it returns a stale/incorrect value (100% observed when the real level was 14.5%). The correct reading comes from the custom `GetBatteryLevel` command (ID 26).
- **Dual firmware images**: Harvard = main MCU, Boylston = BLE chip. Both versioned independently.
