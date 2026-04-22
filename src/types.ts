export type Snapshot = {
  generated_at: string;
  today: TodaySection;
  latest_sleep: SleepSection | null;
  recovery: RecoverySection | null;
  week: WeekSection;
  recent_activities: ActivitySummary[];
  battery: BatteryInfo | null;
  last_sync_at: string | null;
  last_sync_attempt_at: string | null;
  next_sync_at: string | null;
  sync_in_progress: boolean;
  strap_seen_at: string | null;
  alarm: AlarmStatus | null;
  battery_estimate: BatteryEstimate | null;
};

export type RecoveryBand = "red" | "yellow" | "green";
export type RecoveryDriver =
  | "hrv"
  | "rhr"
  | "sleep"
  | "rr"
  | "skin_temp"
  | "none";

export type RecoverySection = {
  score: number;
  band: RecoveryBand;
  dominant_driver: RecoveryDriver;
  for_sleep_id: string; // YYYY-MM-DD
  baseline_window_nights: number;
  calibrating: boolean;
  z_hrv: number | null;
  z_rhr: number | null;
  z_sleep: number | null;
  z_rr: number | null;
  z_skin_temp: number | null;
  hrv_rmssd_ms: number | null;
  /** 0–100 score of current HRV against published age-matched
   * population RMSSD norms. Null when no DOB is configured. */
  age_normed_hrv_score: number | null;
};

export type BatteryEstimate = {
  hours_remaining: number;
  drain_rate_pct_per_hour: number;
  data_points: number;
  confidence: "low" | "moderate" | "good";
};

export type AlarmStatus = {
  enabled: boolean;
  at: string | null;
};

export type BackendConfig = {
  device_name: string | null;
  sync_interval_minutes: number | null;
  presence_interval_minutes: number | null;
  dob: string | null; // YYYY-MM-DD
  /** When true, recent sleep surplus reduces tonight's sleep need
   * (Rupp 2009 "banking"). WHOOP does not expose this; default off. */
  allow_surplus_banking: boolean;
};

export type DiscoveredDevice = {
  name: string;
  rssi: number | null;
};

export type BatteryInfo = {
  percent: number;
  charging: boolean;
  is_worn: boolean;
  updated_at: string;
};

export type TodaySection = {
  sample_count: number;
  last_seen: string | null;
  current_bpm: number | null;
  min_bpm: number | null;
  avg_bpm: number | null;
  max_bpm: number | null;
  latest_stress: number | null;
  latest_spo2: number | null;
  latest_skin_temp: number | null;
  hourly_bpm: (number | null)[];
  hr_series: HrPoint[];
};

export type HrPoint = {
  t: string;
  b: number;
};

export type SleepSection = {
  night: string;
  start: string;
  end: string;
  duration_minutes: number;
  score: number;
  min_bpm: number;
  avg_bpm: number;
  max_bpm: number;
  min_hrv: number;
  avg_hrv: number;
  max_hrv: number;
};

export type WeekSection = {
  sleep_nights: number;
  avg_sleep_duration_minutes: number | null;
  avg_sleep_score: number | null;
  consistency_score: number | null;
  workout_count: number;
  workout_total_minutes: number;
};

export type ActivitySummary = {
  kind: string;
  start: string;
  end: string;
  duration_minutes: number;
};

// ---- sleep staging (get_sleep_snapshot command) ----

export type SleepStage = "Wake" | "Light" | "Deep" | "REM" | "Unknown";

export type HypnogramEntry = {
  start: string;
  end: string;
  stage: SleepStage;
};

export type SleepStageTotals = {
  awake_min: number;
  light_min: number;
  deep_min: number;
  rem_min: number;
};

export type ScoreComponentsBreakdown = {
  sufficiency: number;
  efficiency: number;
  restorative: number;
  consistency: number;
  sleep_stress: number;
};

export type SleepSnapshot = {
  sleep_start: string;
  sleep_end: string;
  stages: SleepStageTotals;
  hypnogram: HypnogramEntry[];
  efficiency: number | null;
  latency_min: number | null;
  waso_min: number | null;
  cycle_count: number | null;
  wake_event_count: number | null;
  avg_respiratory_rate: number | null;
  skin_temp_deviation_c: number | null;
  performance_score: number | null;
  sleep_need_hours: number | null;
  sleep_debt_hours: number | null;
  score_components: ScoreComponentsBreakdown | null;
  classifier_version: string | null;
  /// Nights in the rolling user baseline (<14 = still calibrating).
  baseline_window_nights: number | null;
};

// ---- daily snapshot (get_daily_snapshot command) ----

export type HrvContext = "resting" | "active" | "mixed";

export type HrvSampleLite = {
  window_start: string;
  window_end: string;
  rmssd: number;
  mean_hr: number;
  context: HrvContext | string;
};

export type ActivityBreakdown = {
  sedentary_min: number;
  light_min: number;
  moderate_min: number;
  vigorous_min: number;
  unknown_min: number;
};

export type EventLite = {
  timestamp: string;
  event_id: number;
  event_name: string;
};

export type DeviceInfoLite = {
  recorded_at: string;
  harvard_version: string | null;
  boylston_version: string | null;
  device_name: string | null;
};

export type AlarmLite = {
  action: string;
  action_at: string;
  scheduled_for: string | null;
  enabled: boolean | null;
};

export type SyncLogLite = {
  attempt_started_at: string;
  attempt_ended_at: string | null;
  outcome: string;
  error_message: string | null;
  heart_rate_rows_added: number | null;
  sleep_cycles_created: number | null;
  trigger: string | null;
};

export type DailySnapshot = {
  day_start: string;
  generated_at: string;
  today_wear_minutes: number;
  today_hrv_samples: HrvSampleLite[];
  today_activity_breakdown: ActivityBreakdown;
  recent_events: EventLite[];
  device_info: DeviceInfoLite | null;
  alarm_history: AlarmLite[];
  recent_sync_log: SyncLogLite[];
};

// ---- 14-night history (get_sleep_history command) ----

export type NightEntry = {
  sleep_id: string;          // YYYY-MM-DD
  sleep_start: string;
  sleep_end: string;
  performance_score: number | null;
  stages: SleepStageTotals;
  hypnogram: HypnogramEntry[];
  sleep_efficiency: number | null;
  total_sleep_minutes: number | null;
  sleep_need_hours: number | null;
  sleep_debt_hours: number | null;
  avg_hrv: number;
  classifier_version: string | null;
};

export type DailyRollup = {
  date: string;              // YYYY-MM-DD
  wear_minutes: number;
  daytime_rmssd_avg: number | null;
  daytime_rmssd_samples: number;
  activity: ActivityBreakdown;
};

export type SleepHistory = {
  generated_at: string;
  range_start: string;       // YYYY-MM-DD (inclusive)
  range_end: string;         // YYYY-MM-DD (inclusive)
  nights: NightEntry[];
  daily: DailyRollup[];
};
