import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActivityBreakdown,
  AlarmStatus,
  DailySnapshot,
  DiscoveredDevice,
  EventLite,
  HrvSampleLite,
  HypnogramEntry,
  ScoreComponentsBreakdown,
  SleepSnapshot,
  SleepStage,
  SleepStageTotals,
  Snapshot,
} from "./types";
import "./App.css";

// Stage → hex color. Matches standard hypnogram convention:
// REM reddish, Deep dark blue, Light lighter blue, Wake gray,
// Unknown striped out.
const STAGE_COLOR: Record<SleepStage, string> = {
  Wake: "#71717a",       // zinc-500
  Light: "#60a5fa",      // blue-400
  Deep: "#1e3a8a",       // blue-900
  REM: "#f472b6",        // pink-400
  Unknown: "#3f3f46",    // zinc-700
};

// Hypnogram: horizontal SVG strip showing stage over time.
// Width: 100%, height: 36px. Each segment's width is proportional to
// its (end - start) / total_duration.
function HypnogramStrip({ hypnogram }: { hypnogram: HypnogramEntry[] }) {
  if (hypnogram.length === 0) {
    return (
      <div className="h-9 rounded bg-zinc-900 grid place-items-center text-[10px] text-zinc-600">
        no hypnogram
      </div>
    );
  }
  const t0 = new Date(hypnogram[0].start).getTime();
  const t1 = new Date(hypnogram[hypnogram.length - 1].end).getTime();
  const total = Math.max(1, t1 - t0);
  return (
    <div className="h-9 w-full rounded overflow-hidden flex">
      {hypnogram.map((h, i) => {
        const s = new Date(h.start).getTime();
        const e = new Date(h.end).getTime();
        const pct = ((e - s) / total) * 100;
        return (
          <div
            key={i}
            className="h-full"
            style={{
              width: `${pct}%`,
              backgroundColor: STAGE_COLOR[h.stage] ?? STAGE_COLOR.Unknown,
            }}
            title={`${h.stage} · ${formatTime(h.start)}–${formatTime(h.end)}`}
          />
        );
      })}
    </div>
  );
}

// Stacked horizontal bar showing per-stage minutes. Widths are
// proportional to stage minutes. Segments below ~2% of total are
// omitted from the bar (too narrow to be meaningful visually)
// but still counted in the legend.
function StageBreakdownBar({ stages }: { stages: SleepStageTotals }) {
  const total =
    stages.awake_min + stages.light_min + stages.deep_min + stages.rem_min;
  if (total <= 0) {
    return null;
  }
  const entries: [SleepStage, number][] = [
    ["Wake", stages.awake_min],
    ["Light", stages.light_min],
    ["Deep", stages.deep_min],
    ["REM", stages.rem_min],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-2 w-full rounded-full overflow-hidden flex bg-zinc-900">
        {entries.map(([stage, min]) => {
          const pct = (min / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={stage}
              className="h-full"
              style={{
                width: `${pct}%`,
                backgroundColor: STAGE_COLOR[stage],
              }}
              title={`${stage}: ${Math.round(min)}m`}
            />
          );
        })}
      </div>
      <div className="flex gap-3 text-[10px] text-zinc-400 tabular-nums">
        {entries.map(([stage, min]) => (
          <span key={stage} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: STAGE_COLOR[stage] }}
            />
            {stage} {Math.round(min)}m
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Today card sub-components ----

// Stacked horizontal bar for today's activity minutes. Same treatment
// as the sleep stage bar, different palette (intensity-ramped).
function ActivityBreakdownBar({ b }: { b: ActivityBreakdown }) {
  const total =
    b.sedentary_min + b.light_min + b.moderate_min + b.vigorous_min + b.unknown_min;
  if (total <= 0) return null;
  const entries: [string, number, string][] = [
    ["Sedentary", b.sedentary_min, "#71717a"],  // zinc-500
    ["Light", b.light_min, "#34d399"],          // emerald-400
    ["Moderate", b.moderate_min, "#f59e0b"],    // amber-500
    ["Vigorous", b.vigorous_min, "#ef4444"],    // red-500
    ["Unknown", b.unknown_min, "#3f3f46"],      // zinc-700
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-2 w-full rounded-full overflow-hidden flex bg-zinc-900">
        {entries.map(([label, min, color]) => {
          const pct = (min / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={label}
              className="h-full"
              style={{ width: `${pct}%`, backgroundColor: color }}
              title={`${label}: ${Math.round(min)}m`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400 tabular-nums">
        {entries
          .filter(([, min]) => min > 0)
          .map(([label, min, color]) => (
            <span key={label} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: color }}
              />
              {label} {Math.round(min)}m
            </span>
          ))}
      </div>
    </div>
  );
}

// Sparkline of today's HRV samples (mean_hr vs rmssd not both — just
// rmssd). Context colors the dots: resting green, active red, mixed
// zinc. SVG, no library.
function HrvSparkline({ samples }: { samples: HrvSampleLite[] }) {
  if (samples.length === 0) return null;
  const width = 280;
  const height = 48;
  const pad = 4;
  const min = Math.min(...samples.map((s) => s.rmssd));
  const max = Math.max(...samples.map((s) => s.rmssd));
  const range = Math.max(1, max - min);
  const t0 = new Date(samples[0].window_start).getTime();
  const t1 = new Date(samples[samples.length - 1].window_end).getTime();
  const tRange = Math.max(1, t1 - t0);
  const points = samples.map((s) => {
    const t = new Date(s.window_start).getTime();
    const x = pad + ((t - t0) / tRange) * (width - 2 * pad);
    const y =
      height - pad - ((s.rmssd - min) / range) * (height - 2 * pad);
    return { x, y, s };
  });
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const contextColor = (c: string) =>
    c === "resting" ? "#10b981" : c === "active" ? "#ef4444" : "#a1a1aa";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          HRV (RMSSD) today
        </span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {samples.length} sample{samples.length === 1 ? "" : "s"} ·{" "}
          {Math.round(min)}–{Math.round(max)} ms
        </span>
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded bg-zinc-900/50"
        preserveAspectRatio="none"
      >
        <path
          d={path}
          fill="none"
          stroke="#a1a1aa"
          strokeWidth="1"
          strokeOpacity="0.5"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={2}
            fill={contextColor(p.s.context)}
          >
            <title>
              {new Date(p.s.window_start).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              : RMSSD {Math.round(p.s.rmssd)} ms · HR {Math.round(p.s.mean_hr)} ·{" "}
              {p.s.context}
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

// Compact list of today's events — timestamp + name. Collapses
// consecutive duplicates (e.g. back-to-back BatteryLevel pings).
function EventsList({ events }: { events: EventLite[] }) {
  if (events.length === 0) return null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Dedupe consecutive same-name (keep first of each run).
  const deduped: EventLite[] = [];
  let lastName = "";
  for (const e of events) {
    if (e.event_name !== lastName) {
      deduped.push(e);
      lastName = e.event_name;
    }
  }
  const todayEvents = deduped
    .filter((e) => {
      const d = new Date(e.timestamp);
      return d.toDateString() === new Date().toDateString();
    })
    .slice(-8)
    .reverse();
  if (todayEvents.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        Recent events
      </span>
      <ul className="flex flex-col gap-0.5 text-[11px] text-zinc-300 tabular-nums">
        {todayEvents.map((e, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="text-zinc-500 w-10">{fmt(e.timestamp)}</span>
            <span>{e.event_name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Score components as 5 mini horizontal bars (0–100 each). Compact;
// renders the composite score's breakdown without a chart library.
function ScoreComponentBars({ c }: { c: ScoreComponentsBreakdown }) {
  const items: [string, number, string][] = [
    ["Sufficiency", c.sufficiency, "bg-emerald-500"],
    ["Efficiency", c.efficiency, "bg-blue-500"],
    ["Restorative", c.restorative, "bg-violet-500"],
    ["Consistency", c.consistency, "bg-amber-500"],
    ["Sleep stress", c.sleep_stress, "bg-teal-500"],
  ];
  return (
    <div className="grid grid-cols-5 gap-2">
      {items.map(([label, value, bg]) => (
        <div key={label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-1">
            <span className="text-[10px] text-zinc-500 truncate" title={label}>
              {label}
            </span>
            <span className="text-[10px] text-zinc-300 tabular-nums">
              {Math.round(value)}
            </span>
          </div>
          <div className="h-1 w-full rounded-full bg-zinc-900 overflow-hidden">
            <div
              className={`h-full ${bg}`}
              style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

type SyncStage = "scanning" | "connecting" | "downloading" | "processing" | "done";

const STAGE_LABEL: Record<SyncStage, string> = {
  scanning: "Scanning for strap…",
  connecting: "Connecting…",
  downloading: "Downloading history…",
  processing: "Processing metrics…",
  done: "Finishing up…",
};

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatClock(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRelative(iso: string | null, prefix: string): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 30_000 && ms > -30_000) return `${prefix} now`;
  const absMs = Math.abs(ms);
  const mins = Math.round(absMs / 60000);
  const hours = Math.round(absMs / 3600000);
  const unit = mins < 60 ? `${mins}m` : `${hours}h`;
  return ms > 0 ? `${prefix} in ${unit}` : `${prefix} ${unit} ago`;
}

const INTERVAL_OPTIONS: { label: string; minutes: number }[] = [
  { label: "Manual only", minutes: 0 },
  { label: "Every 15 minutes", minutes: 15 },
  { label: "Every hour", minutes: 60 },
  { label: "Every 4 hours", minutes: 240 },
  { label: "Daily", minutes: 1440 },
];

const PRESENCE_OPTIONS: { label: string; minutes: number }[] = [
  { label: "Off", minutes: 0 },
  { label: "Every 1 minute", minutes: 1 },
  { label: "Every 2 minutes", minutes: 2 },
  { label: "Every 5 minutes", minutes: 5 },
  { label: "Every 10 minutes", minutes: 10 },
];

type ClassifiedError = {
  message: string;
  hint: string | null;
  retryable: boolean;
};

function classifyError(raw: string): ClassifiedError {
  const s = raw.toLowerCase();
  if (s.includes("not found within")) {
    return {
      message: "Strap not in range",
      hint: "Move closer to the strap and try again.",
      retryable: true,
    };
  }
  if (s.includes("no bluetooth adapter")) {
    return {
      message: "Bluetooth unavailable",
      hint: "Enable Bluetooth in System Settings → Privacy & Security.",
      retryable: true,
    };
  }
  if (s.includes("whoop disconnected") || s.includes("disconnected mid")) {
    return {
      message: "Connection dropped mid-sync",
      hint: "The strap disconnected. Try again.",
      retryable: true,
    };
  }
  if (s.includes("timed out after") && s.includes("seconds")) {
    return {
      message: "Sync timed out",
      hint: "The strap took too long to respond. Try again or reboot the strap.",
      retryable: true,
    };
  }
  if (s.includes("stopped sending data")) {
    return {
      message: "Strap went quiet",
      hint: "No data received for 30 seconds. Try again or reboot the strap.",
      retryable: true,
    };
  }
  if (s.includes("device not configured")) {
    return {
      message: "No strap configured",
      hint: "Open settings and scan for your strap.",
      retryable: false,
    };
  }
  if (s.includes("sync in progress") || s.includes("already in progress")) {
    return {
      message: "Sync already running",
      hint: null,
      retryable: false,
    };
  }
  if (s.includes("sync cancelled")) {
    return {
      message: "Sync cancelled",
      hint: null,
      retryable: true,
    };
  }
  return { message: raw, hint: null, retryable: true };
}

type TimeScale = { label: string; hours: number; bins: number; binMinutes: number };

const TIME_SCALES: TimeScale[] = [
  { label: "1H", hours: 1, bins: 20, binMinutes: 3 },
  { label: "2H", hours: 2, bins: 24, binMinutes: 5 },
  { label: "4H", hours: 4, bins: 24, binMinutes: 10 },
  { label: "8H", hours: 8, bins: 24, binMinutes: 20 },
  { label: "12H", hours: 12, bins: 24, binMinutes: 30 },
  { label: "24H", hours: 24, bins: 24, binMinutes: 60 },
];

type Bin = {
  label: string;
  min: number;
  avg: number;
  max: number;
  count: number;
} | null;

function binSeries(
  series: { t: string; b: number }[],
  scale: TimeScale,
): Bin[] {
  const now = Date.now();
  const windowStart = now - scale.hours * 3600_000;
  const binMs = scale.binMinutes * 60_000;
  const bins: Bin[] = Array(scale.bins).fill(null);

  for (const pt of series) {
    const ts = new Date(pt.t).getTime();
    if (ts < windowStart || ts > now) continue;
    const idx = Math.min(
      Math.floor((ts - windowStart) / binMs),
      scale.bins - 1,
    );
    const b = bins[idx];
    if (b) {
      b.min = Math.min(b.min, pt.b);
      b.max = Math.max(b.max, pt.b);
      b.avg = (b.avg * b.count + pt.b) / (b.count + 1);
      b.count++;
    } else {
      const binStart = new Date(windowStart + idx * binMs);
      bins[idx] = {
        label: binStart.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        min: pt.b,
        avg: pt.b,
        max: pt.b,
        count: 1,
      };
    }
  }
  return bins;
}

function zoneColor(bpm: number): string {
  if (bpm < 65) return "bg-emerald-500";
  if (bpm < 85) return "bg-emerald-400";
  if (bpm < 100) return "bg-amber-400";
  if (bpm < 120) return "bg-orange-400";
  return "bg-rose-400";
}

function HrChart({
  series,
}: {
  series: { t: string; b: number }[];
}) {
  const [scaleIdx, setScaleIdx] = useState(TIME_SCALES.length - 1);
  const [hovered, setHovered] = useState<Bin>(null);
  const scale = TIME_SCALES[scaleIdx];
  const bins = binSeries(series, scale);

  const filled = bins.filter((b): b is NonNullable<Bin> => b !== null);
  if (filled.length === 0) {
    return <div className="text-zinc-600 text-xs">No data in this window.</div>;
  }
  const globalMin = Math.min(...filled.map((b) => b.min));
  const globalMax = Math.max(...filled.map((b) => b.max));
  const span = Math.max(1, globalMax - globalMin);

  // Generate ~5 evenly spaced time labels across the window.
  const windowStart = Date.now() - scale.hours * 3600_000;
  const labelCount = 5;
  const labels = Array.from({ length: labelCount }, (_, i) => {
    const ts = windowStart + (i / (labelCount - 1)) * scale.hours * 3600_000;
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {TIME_SCALES.map((s, i) => (
            <button
              key={s.label}
              onClick={() => setScaleIdx(i)}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                i === scaleIdx
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {hovered && (
          <span className="text-[9px] text-zinc-400 tabular-nums">
            {hovered.label} — {Math.round(hovered.min)}/{Math.round(hovered.avg)}/{Math.round(hovered.max)} bpm
            <span className="text-zinc-600 ml-1">(lo/avg/hi)</span>
          </span>
        )}
      </div>
      <div
        className="flex items-end gap-[2px] h-12 w-full"
        onMouseLeave={() => setHovered(null)}
      >
        {bins.map((bin, i) => {
          const height =
            bin === null
              ? 4
              : 6 + Math.round(((bin.avg - globalMin) / span) * 40);
          return (
            <div
              key={i}
              className={`flex-1 rounded-sm transition-all cursor-default ${
                bin === null ? "bg-zinc-800/50" : zoneColor(bin.avg)
              }`}
              style={{ height, opacity: bin === null ? 0.3 : 0.85 }}
              onMouseEnter={() => setHovered(bin)}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 tabular-nums">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  hint,
  onClick,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <span className="text-lg font-medium tabular-nums leading-tight">
        {value}
        {unit && (
          <span className="text-[10px] text-zinc-500 ml-1 font-normal">
            {unit}
          </span>
        )}
      </span>
      {hint && <span className="text-[10px] text-zinc-600">{hint}</span>}
    </>
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="flex flex-col items-start text-left cursor-pointer hover:opacity-80 transition-opacity"
      >
        {content}
      </button>
    );
  }
  return <div className="flex flex-col">{content}</div>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[10px] uppercase tracking-[0.15em] text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BatteryPill({
  percent,
  charging,
  estimate,
}: {
  percent: number;
  charging: boolean;
  estimate: { hours_remaining: number; confidence: string } | null;
}) {
  const color =
    charging
      ? "bg-sky-400"
      : percent > 50
      ? "bg-emerald-400"
      : percent > 20
      ? "bg-amber-400"
      : "bg-rose-400";
  const timeStr = estimate
    ? estimate.hours_remaining >= 1
      ? `~${Math.round(estimate.hours_remaining)}h`
      : `~${Math.round(estimate.hours_remaining * 60)}m`
    : null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-[9px] font-normal text-zinc-400 tabular-nums"
      title={
        estimate
          ? `${estimate.hours_remaining.toFixed(1)}h remaining (${estimate.confidence} confidence)`
          : undefined
      }
    >
      <span className={`w-1 h-1 rounded-full ${color}`} />
      {percent.toFixed(1)}%
      {charging && <span className="text-sky-400">⚡</span>}
      {!charging && timeStr && (
        <span className="text-zinc-500">{timeStr}</span>
      )}
    </span>
  );
}

function WristPill({ isWorn }: { isWorn: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-[9px] font-normal text-zinc-400">
      <span
        className={`w-1 h-1 rounded-full ${
          isWorn ? "bg-emerald-400" : "bg-zinc-600"
        }`}
      />
      {isWorn ? "on wrist" : "off wrist"}
    </span>
  );
}

function PresencePill({ seenAt }: { seenAt: string | null }) {
  if (!seenAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-[9px] font-normal text-zinc-500">
        <span className="w-1 h-1 rounded-full bg-zinc-600" />
        not detected
      </span>
    );
  }
  const ageMs = Date.now() - new Date(seenAt).getTime();
  const recent = ageMs < 5 * 60_000;
  const label = recent
    ? "in range"
    : (formatRelative(seenAt, "seen") ?? "not detected");
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-[9px] font-normal text-zinc-400">
      <span
        className={`w-1 h-1 rounded-full ${
          recent ? "bg-emerald-400" : "bg-zinc-600"
        }`}
      />
      {label}
    </span>
  );
}

type TempUnit = "C" | "F";

function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

type SyncReport = {
  duration_secs: number;
  new_readings: number;
  total_readings: number;
  sleep_nights: number;
  activities: number;
};

type BackendConfig = {
  device_name: string | null;
  sync_interval_minutes: number | null;
  presence_interval_minutes: number | null;
};

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sleepSnapshot, setSleepSnapshot] = useState<SleepSnapshot | null>(null);
  const [dailySnapshot, setDailySnapshot] = useState<DailySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStage, setSyncStage] = useState<SyncStage | null>(null);
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => {
    return (localStorage.getItem("tempUnit") as TempUnit) || "C";
  });
  const [deviceName, setDeviceName] = useState<string>("");
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [syncInterval, setSyncInterval] = useState<number>(0);
  const [presenceInterval, setPresenceInterval] = useState<number>(2);
  const [autostart, setAutostart] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanResults, setScanResults] = useState<DiscoveredDevice[]>([]);
  const [downloadCount, setDownloadCount] = useState<number>(0);
  const [alarmInput, setAlarmInput] = useState<string>("07:00");
  const [alarmBusy, setAlarmBusy] = useState<boolean>(false);
  const [alarmInputTouched, setAlarmInputTouched] = useState<boolean>(false);
  const [tick, setTick] = useState(0);
  // tick increments every 30s so the "Next sync in Xm" label re-renders
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(i);
  }, []);
  void tick;

  const toggleTemp = () => {
    const next: TempUnit = tempUnit === "C" ? "F" : "C";
    setTempUnit(next);
    localStorage.setItem("tempUnit", next);
  };

  const saveDeviceName = async (name: string) => {
    setDeviceName(name);
    try {
      await invoke("set_device_name", { name });
    } catch (e) {
      setError(String(e));
    }
  };

  const saveSyncInterval = async (minutes: number) => {
    setSyncInterval(minutes);
    try {
      await invoke("set_sync_interval", {
        minutes: minutes === 0 ? null : minutes,
      });
    } catch (e) {
      setError(String(e));
    }
  };

  const savePresenceInterval = async (minutes: number) => {
    setPresenceInterval(minutes);
    try {
      await invoke("set_presence_interval", { minutes });
    } catch (e) {
      setError(String(e));
    }
  };

  const saveAutostart = async (enabled: boolean) => {
    setAutostart(enabled);
    try {
      await invoke("set_autostart", { enabled });
    } catch (e) {
      setError(String(e));
      setAutostart(!enabled);
    }
  };

  const onScanDevices = async () => {
    setScanning(true);
    setError(null);
    setScanResults([]);
    try {
      const devices = await invoke<DiscoveredDevice[]>("scan_devices");
      setScanResults(devices);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const snap = await invoke<Snapshot>("get_snapshot");
      setSnapshot(snap);
      setError(null);
      // Phase 1: also pull the rich sleep snapshot. Failure here is
      // non-fatal — staging may not have run on an empty DB.
      try {
        const sleep = await invoke<SleepSnapshot | null>("get_sleep_snapshot");
        setSleepSnapshot(sleep);
      } catch {
        setSleepSnapshot(null);
      }
      // Phase 2: today's daytime data. Same non-fatal pattern.
      try {
        const daily = await invoke<DailySnapshot>("get_daily_snapshot");
        setDailySnapshot(daily);
      } catch {
        setDailySnapshot(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Initial hydration: load config + autostart state, then snapshot. Also
  // poll snapshot every 30s so scheduler-driven syncs show up live.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<BackendConfig>("get_config");
        const name = cfg.device_name ?? "";
        setDeviceName(name);
        setSyncInterval(cfg.sync_interval_minutes ?? 0);
        setPresenceInterval(cfg.presence_interval_minutes ?? 2);
        if (!name) setShowSettings(true);
      } catch (e) {
        setError(String(e));
      }
      try {
        const enabled = await invoke<boolean>("get_autostart");
        setAutostart(enabled);
      } catch {
        // non-fatal
      }
      refresh();
    })();
    const poll = setInterval(refresh, 30_000);
    return () => clearInterval(poll);
  }, [refresh]);

  // Subscribe to sync lifecycle events from the backend (including tray-initiated syncs).
  useEffect(() => {
    const unlistenFns: (() => void)[] = [];
    (async () => {
      unlistenFns.push(
        await listen<SyncStage>("sync:progress", (e) => {
          setSyncStage(e.payload);
          setSyncing(e.payload !== "done");
          if (e.payload === "scanning") {
            setDownloadCount(0);
          }
        })
      );
      unlistenFns.push(
        await listen<number>("sync:download_progress", (e) => {
          setDownloadCount(e.payload);
        })
      );
      unlistenFns.push(
        await listen<SyncReport>("sync:complete", (e) => {
          setLastSync(e.payload);
          setSyncing(false);
          setSyncStage(null);
          setDownloadCount(0);
          refresh();
        })
      );
      unlistenFns.push(
        await listen<string>("sync:error", (e) => {
          setError(e.payload);
          setSyncing(false);
          setSyncStage(null);
          setDownloadCount(0);
        })
      );
      unlistenFns.push(
        await listen("alarm:updated", () => {
          refresh();
        })
      );
    })();
    return () => unlistenFns.forEach((fn) => fn());
  }, [refresh]);

  const onCancelSync = async () => {
    try {
      await invoke("cancel_sync");
    } catch (e) {
      setError(String(e));
    }
  };

  // Auto-dismiss the success toast after 8s.
  useEffect(() => {
    if (!lastSync) return;
    const t = setTimeout(() => setLastSync(null), 8000);
    return () => clearTimeout(t);
  }, [lastSync]);

  // Mirror the strap's current alarm into the picker, but only if the user
  // hasn't typed anything yet — otherwise edits get clobbered every refresh.
  useEffect(() => {
    if (alarmInputTouched) return;
    if (snapshot?.alarm?.enabled && snapshot.alarm.at) {
      const d = new Date(snapshot.alarm.at);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      setAlarmInput(`${hh}:${mm}`);
    }
  }, [snapshot?.alarm, alarmInputTouched]);

  // ---------- Alarm helpers ----------

  const resolveAlarmUnix = (hhmm: string): number | null => {
    // hhmm is "HH:MM". Returns next-occurrence unix timestamp (seconds).
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const hours = Number(m[1]);
    const mins = Number(m[2]);
    if (hours > 23 || mins > 59) return null;
    const target = new Date();
    target.setHours(hours, mins, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1); // next day
    }
    return Math.floor(target.getTime() / 1000);
  };

  const onSetAlarm = async () => {
    const unix = resolveAlarmUnix(alarmInput);
    if (unix == null) {
      setError("Enter a time in HH:MM format");
      return;
    }
    setAlarmBusy(true);
    setError(null);
    try {
      await invoke<AlarmStatus>("set_alarm", { unix });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAlarmBusy(false);
    }
  };

  const onClearAlarm = async () => {
    setAlarmBusy(true);
    setError(null);
    try {
      await invoke<AlarmStatus>("clear_alarm");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAlarmBusy(false);
    }
  };

  const onRefreshAlarm = async () => {
    setAlarmBusy(true);
    setError(null);
    try {
      await invoke<AlarmStatus>("get_alarm");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAlarmBusy(false);
    }
  };

  const onRingStrap = async () => {
    setAlarmBusy(true);
    setError(null);
    try {
      await invoke("ring_strap");
    } catch (e) {
      setError(String(e));
    } finally {
      setAlarmBusy(false);
    }
  };

  const onSync = async () => {
    if (!deviceName.trim()) {
      setShowSettings(true);
      setError("Set a device name first.");
      return;
    }
    setSyncing(true);
    setSyncStage("scanning");
    setError(null);
    try {
      const report = await invoke<SyncReport>("sync_now");
      setLastSync(report);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
      setSyncStage(null);
    }
  };

  const t = snapshot?.today;
  const s = snapshot?.latest_sleep;
  const w = snapshot?.week;

  return (
    <main className="flex flex-col h-screen overflow-y-auto px-6 py-5 gap-6 text-zinc-100">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-1.5 flex-wrap">
            OpenWhoop
            {snapshot?.battery && (
              <>
                <BatteryPill
                  percent={snapshot.battery.percent}
                  charging={snapshot.battery.charging}
                  estimate={snapshot.battery_estimate}
                />
                <WristPill isWorn={snapshot.battery.is_worn} />
              </>
            )}
            <PresencePill seenAt={snapshot?.strap_seen_at ?? null} />
          </h1>
          <p className="text-xs text-zinc-500">
            {syncing && syncStage === "downloading" && downloadCount > 0
              ? `Downloading… ${downloadCount.toLocaleString()} new readings`
              : syncing && syncStage === "downloading"
              ? "Downloading history…"
              : syncing && syncStage
              ? STAGE_LABEL[syncStage]
              : syncing
              ? "Syncing with strap…"
              : snapshot?.next_sync_at
              ? formatRelative(snapshot.next_sync_at, "Next sync") ??
                `Last refresh ${formatClock(snapshot.generated_at)}`
              : snapshot?.last_sync_at
              ? formatRelative(snapshot.last_sync_at, "Last sync") ??
                `Last refresh ${formatClock(snapshot.generated_at)}`
              : snapshot
              ? `Last refresh ${formatClock(snapshot.generated_at)}`
              : "Loading…"}
          </p>
          {dailySnapshot && (
            <p className="text-[10px] text-zinc-600 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mt-0.5">
              {dailySnapshot.device_info?.harvard_version && (
                <span>
                  fw{" "}
                  <span className="text-zinc-500">
                    {dailySnapshot.device_info.harvard_version}
                    {dailySnapshot.device_info.boylston_version
                      ? ` · ${dailySnapshot.device_info.boylston_version}`
                      : ""}
                  </span>
                </span>
              )}
              {dailySnapshot.recent_sync_log[0]?.outcome === "error" && (
                <span
                  className="text-amber-400"
                  title={
                    dailySnapshot.recent_sync_log[0]?.error_message ?? undefined
                  }
                >
                  last sync failed
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-md border border-zinc-800 hover:border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Settings"
          >
            ⚙
          </button>
          {syncing ? (
            <button
              onClick={onCancelSync}
              className="rounded-md border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onSync}
              className="rounded-md bg-rose-500/90 hover:bg-rose-500 active:bg-rose-600 px-3 py-1.5 text-xs font-medium transition-colors"
            >
              Sync now
            </button>
          )}
        </div>
      </header>

      {showSettings && (
        <div className="flex flex-col gap-4 rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">
              Device
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={deviceName}
                onChange={(e) => saveDeviceName(e.target.value)}
                placeholder="WHOOP 4C0968309"
                className="flex-1 rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={onScanDevices}
                disabled={scanning}
                className="rounded border border-zinc-800 hover:border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {scanning ? "Scanning…" : "Scan"}
              </button>
            </div>
            {scanResults.length > 0 && (
              <ul className="flex flex-col gap-1 rounded border border-zinc-800 bg-black/40 p-1.5">
                {scanResults.map((d) => (
                  <li key={d.name}>
                    <button
                      onClick={() => {
                        saveDeviceName(d.name);
                        setScanResults([]);
                      }}
                      className="w-full text-left rounded px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800/70 flex items-center justify-between"
                    >
                      <span>{d.name}</span>
                      {d.rssi != null && (
                        <span className="text-[10px] text-zinc-500 tabular-nums">
                          {d.rssi} dBm
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!scanning && scanResults.length === 0 && (
              <p className="text-[10px] text-zinc-600">
                Click Scan to discover nearby WHOOP straps, or type the name
                manually.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">
              Auto-sync
            </label>
            <select
              value={syncInterval}
              onChange={(e) => saveSyncInterval(Number(e.target.value))}
              className="rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.minutes} value={opt.minutes}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">
              Presence scan
            </label>
            <select
              value={presenceInterval}
              onChange={(e) => savePresenceInterval(Number(e.target.value))}
              className="rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
            >
              {PRESENCE_OPTIONS.map((opt) => (
                <option key={opt.minutes} value={opt.minutes}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-zinc-600">
              Quick BLE scan to detect when the strap is nearby. Auto-syncs
              when it comes back in range.
            </p>
          </div>

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Launch at login
            </span>
            <input
              type="checkbox"
              checked={autostart}
              onChange={(e) => saveAutostart(e.target.checked)}
              className="accent-rose-500"
            />
          </label>

          <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">
                Strap alarm
              </label>
              <button
                onClick={onRefreshAlarm}
                disabled={alarmBusy}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                refresh
              </button>
            </div>
            <p className="text-[11px] text-zinc-400 tabular-nums">
              {snapshot?.alarm?.enabled && snapshot.alarm.at
                ? `Alarm set for ${formatTime(snapshot.alarm.at)} on ${new Date(
                    snapshot.alarm.at,
                  ).toLocaleDateString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}`
                : snapshot?.alarm
                ? "No alarm currently set"
                : "Status unknown — click refresh"}
            </p>
            <div className="flex gap-2">
              <input
                type="time"
                value={alarmInput}
                onChange={(e) => {
                  setAlarmInput(e.target.value);
                  setAlarmInputTouched(true);
                }}
                className="flex-1 rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600 [color-scheme:dark]"
              />
              <button
                onClick={onSetAlarm}
                disabled={alarmBusy || !alarmInput}
                className="rounded border border-zinc-800 hover:border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Set
              </button>
              <button
                onClick={onClearAlarm}
                disabled={alarmBusy || !snapshot?.alarm?.enabled}
                className="rounded border border-zinc-800 hover:border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Clear
              </button>
            </div>
            {alarmBusy && (
              <p className="text-[10px] text-zinc-500">
                Talking to the strap…
              </p>
            )}
            <button
              onClick={onRingStrap}
              disabled={alarmBusy}
              className="rounded border border-zinc-800 hover:border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Buzz strap (find it)
            </button>
          </div>
        </div>
      )}

      {lastSync && !syncing && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
          <span className="flex-1">
            Synced in {lastSync.duration_secs.toFixed(1)}s · +
            {lastSync.new_readings} new readings · {lastSync.total_readings}{" "}
            total · {lastSync.sleep_nights} sleep nights ·{" "}
            {lastSync.activities} activities
          </span>
          <button
            onClick={() => setLastSync(null)}
            className="text-emerald-400/60 hover:text-emerald-300 leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {error &&
        (() => {
          const c = classifyError(error);
          return (
            <div className="flex items-start gap-2 rounded-md border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              <div className="flex-1 flex flex-col gap-0.5">
                <span className="font-medium">{c.message}</span>
                {c.hint && (
                  <span className="text-rose-400/70">{c.hint}</span>
                )}
              </div>
              {c.retryable && !syncing && (
                <button
                  onClick={() => {
                    setError(null);
                    onSync();
                  }}
                  className="rounded border border-rose-800 hover:border-rose-700 px-2 py-0.5 text-[10px] text-rose-300 hover:text-rose-100 transition-colors"
                >
                  Retry
                </button>
              )}
              <button
                onClick={() => setError(null)}
                className="text-rose-400/60 hover:text-rose-300 leading-none"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          );
        })()}

      <Section title="Today">
        {t && t.sample_count > 0 ? (
          <>
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-semibold tabular-nums">
                {t.current_bpm ?? "--"}
              </span>
              <span className="text-xs text-zinc-500">bpm</span>
              <span className="text-[10px] text-zinc-600 ml-auto">
                {t.sample_count} samples · last {formatClock(t.last_seen)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Min"
                value={`${t.min_bpm ?? "--"}`}
                unit="bpm"
              />
              <Stat
                label="Avg"
                value={`${t.avg_bpm ?? "--"}`}
                unit="bpm"
              />
              <Stat
                label="Max"
                value={`${t.max_bpm ?? "--"}`}
                unit="bpm"
              />
            </div>
            <div className="grid grid-cols-3 gap-4 pt-1">
              <Stat
                label="Stress"
                value={
                  t.latest_stress != null ? t.latest_stress.toFixed(1) : "--"
                }
              />
              <Stat
                label="SpO₂"
                value={
                  t.latest_spo2 != null ? `${Math.round(t.latest_spo2)}%` : "--"
                }
              />
              <Stat
                label={`Skin (°${tempUnit})`}
                value={
                  t.latest_skin_temp != null
                    ? (tempUnit === "F"
                        ? cToF(t.latest_skin_temp)
                        : t.latest_skin_temp
                      ).toFixed(1) + "°"
                    : "--"
                }
                onClick={toggleTemp}
                hint="click to toggle"
              />
            </div>
            <div className="pt-2">
              <HrChart series={t.hr_series} />
            </div>
          </>
        ) : (
          <p className="text-xs text-zinc-500">
            No heart-rate data yet today. Tap <em>Sync now</em>.
          </p>
        )}
      </Section>

      <Section title="Latest sleep">
        {s ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{s.night}</span>
                {sleepSnapshot &&
                  sleepSnapshot.baseline_window_nights != null &&
                  sleepSnapshot.baseline_window_nights < 14 && (
                    <span
                      className="rounded-full bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-300"
                      title={`Score calibrating: ${sleepSnapshot.baseline_window_nights} of 14 nights of baseline history. Accuracy improves as more data accumulates.`}
                    >
                      Calibrating
                    </span>
                  )}
              </div>
              <span className="text-xs text-zinc-500 tabular-nums">
                {formatTime(s.start)} → {formatTime(s.end)}
              </span>
            </div>
            {sleepSnapshot && sleepSnapshot.hypnogram.length > 0 && (
              <HypnogramStrip hypnogram={sleepSnapshot.hypnogram} />
            )}
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Duration"
                value={formatDuration(s.duration_minutes)}
              />
              <Stat label="Score" value={Math.round(s.score).toString()} />
              <Stat
                label="Avg HR"
                value={`${s.avg_bpm}`}
                unit="bpm"
                hint={`${s.min_bpm}–${s.max_bpm}`}
              />
              <Stat
                label="Avg HRV"
                value={`${s.avg_hrv}`}
                unit="ms"
                hint={`${s.min_hrv}–${s.max_hrv}`}
              />
            </div>
            {sleepSnapshot && (
              <StageBreakdownBar stages={sleepSnapshot.stages} />
            )}
            {sleepSnapshot?.score_components && (
              <ScoreComponentBars c={sleepSnapshot.score_components} />
            )}
            {sleepSnapshot && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-400 tabular-nums">
                {sleepSnapshot.efficiency != null && (
                  <span>
                    Eff{" "}
                    <span className="text-zinc-200">
                      {Math.round(sleepSnapshot.efficiency)}%
                    </span>
                  </span>
                )}
                {sleepSnapshot.latency_min != null && (
                  <span>
                    Latency{" "}
                    <span className="text-zinc-200">
                      {Math.round(sleepSnapshot.latency_min)}m
                    </span>
                  </span>
                )}
                {sleepSnapshot.waso_min != null && (
                  <span>
                    WASO{" "}
                    <span className="text-zinc-200">
                      {Math.round(sleepSnapshot.waso_min)}m
                    </span>
                  </span>
                )}
                {sleepSnapshot.cycle_count != null && (
                  <span>
                    Cycles{" "}
                    <span className="text-zinc-200">
                      {sleepSnapshot.cycle_count}
                    </span>
                  </span>
                )}
                {sleepSnapshot.wake_event_count != null && (
                  <span>
                    Wake events{" "}
                    <span className="text-zinc-200">
                      {sleepSnapshot.wake_event_count}
                    </span>
                  </span>
                )}
              </div>
            )}
            {sleepSnapshot &&
              (sleepSnapshot.avg_respiratory_rate != null ||
                sleepSnapshot.skin_temp_deviation_c != null) && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-400 tabular-nums">
                  {sleepSnapshot.avg_respiratory_rate != null && (
                    <span>
                      Respiratory{" "}
                      <span className="text-zinc-200">
                        {sleepSnapshot.avg_respiratory_rate.toFixed(1)} bpm
                      </span>
                    </span>
                  )}
                  {sleepSnapshot.skin_temp_deviation_c != null && (
                    <span
                      className={
                        Math.abs(sleepSnapshot.skin_temp_deviation_c) > 0.5
                          ? "text-amber-400"
                          : undefined
                      }
                      title={
                        Math.abs(sleepSnapshot.skin_temp_deviation_c) > 0.5
                          ? "Notable deviation from baseline"
                          : undefined
                      }
                    >
                      Skin temp Δ{" "}
                      <span className="text-zinc-200">
                        {sleepSnapshot.skin_temp_deviation_c >= 0 ? "+" : ""}
                        {sleepSnapshot.skin_temp_deviation_c.toFixed(2)}°C
                      </span>
                    </span>
                  )}
                </div>
              )}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            No sleep cycles detected yet.
          </p>
        )}
      </Section>

      {dailySnapshot && (
        <Section title="Today's activity">
          <div className="flex flex-col gap-3">
            {dailySnapshot.today_wear_minutes > 0 && (
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-zinc-400">Wear time</span>
                <span className="text-zinc-200 tabular-nums">
                  {formatDuration(Math.round(dailySnapshot.today_wear_minutes))}
                </span>
              </div>
            )}
            {dailySnapshot.today_activity_breakdown &&
              (dailySnapshot.today_activity_breakdown.sedentary_min +
                dailySnapshot.today_activity_breakdown.light_min +
                dailySnapshot.today_activity_breakdown.moderate_min +
                dailySnapshot.today_activity_breakdown.vigorous_min) >
                0 && (
                <ActivityBreakdownBar
                  b={dailySnapshot.today_activity_breakdown}
                />
              )}
            {dailySnapshot.today_hrv_samples.length > 0 && (
              <HrvSparkline samples={dailySnapshot.today_hrv_samples} />
            )}
            <EventsList events={dailySnapshot.recent_events} />
            {dailySnapshot.today_wear_minutes === 0 &&
              dailySnapshot.today_hrv_samples.length === 0 &&
              dailySnapshot.recent_events.length === 0 && (
                <p className="text-xs text-zinc-500">
                  No data today yet. Run <em>detect-events</em> after a sync.
                </p>
              )}
          </div>
        </Section>
      )}

      <Section title="Last 7 days">
        {w && (w.sleep_nights > 0 || w.workout_count > 0) ? (
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Nights"
              value={`${w.sleep_nights}`}
              hint={
                w.avg_sleep_duration_minutes != null
                  ? `avg ${formatDuration(w.avg_sleep_duration_minutes)}`
                  : undefined
              }
            />
            <Stat
              label="Sleep score"
              value={
                w.avg_sleep_score != null
                  ? Math.round(w.avg_sleep_score).toString()
                  : "--"
              }
              hint={
                w.consistency_score != null
                  ? `consistency ${Math.round(w.consistency_score)}/100`
                  : undefined
              }
            />
            <Stat
              label="Workouts"
              value={`${w.workout_count}`}
              hint={
                w.workout_total_minutes > 0
                  ? formatDuration(w.workout_total_minutes)
                  : undefined
              }
            />
          </div>
        ) : (
          <p className="text-xs text-zinc-500">Nothing logged this week.</p>
        )}
      </Section>
    </main>
  );
}

export default App;
