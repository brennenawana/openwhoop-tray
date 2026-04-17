export type Snapshot = {
  generated_at: string;
  today: TodaySection;
  latest_sleep: SleepSection | null;
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
