export type Snapshot = {
  generated_at: string;
  today: TodaySection;
  latest_sleep: SleepSection | null;
  week: WeekSection;
  recent_activities: ActivitySummary[];
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
