import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  HypnogramModal,
  SkylineHypnogram,
  STAGE_COLOR,
} from "./Hypnogram";
import type {
  ActivityBreakdown,
  AlarmStatus,
  DailySnapshot,
  DiscoveredDevice,
  EventLite,
  HrvSampleLite,
  HypnogramEntry,
  RecoverySection,
  ScoreComponentsBreakdown,
  SleepSnapshot,
  SleepStage,
  SleepStageTotals,
  Snapshot,
} from "./types";
import "./App.css";
import { HistoryView } from "./HistoryView";

type View = "now" | "history";

/** Display mode toggles between the compact tray window and a wider
 *  multi-column layout. Independent of view: both Now and History
 *  render in either mode, and the selection is persisted. */
type Mode = "compact" | "expanded";

const MODE_WINDOW_SIZE: Record<Mode, { w: number; h: number }> = {
  compact: { w: 420, h: 620 },
  expanded: { w: 1100, h: 720 },
};

/** Section IDs used by the Now-page show/hide customization. Order
 *  here is the canonical render order; users can hide any of them but
 *  the layout itself is fixed (no reorder). */
type SectionId =
  | "recovery"
  | "today"
  | "latest_sleep"
  | "week"
  | "activity";

const SECTION_LABELS: Record<SectionId, string> = {
  recovery: "Recovery",
  today: "Today",
  latest_sleep: "Latest sleep",
  week: "Last 7 days",
  activity: "Today's activity",
};

type Theme = "monokai" | "midnight" | "slate" | "light";

const THEME_OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "monokai", label: "Monokai", hint: "Warm dim grey" },
  { value: "midnight", label: "Midnight", hint: "Pitch black" },
  { value: "slate", label: "Slate", hint: "Cool grey" },
  { value: "light", label: "Light", hint: "Off-white" },
];

// Sleep-journey hypnogram.
//
// Each timeline slice is a filled rectangle; height encodes sleep
// depth, color encodes stage. Rendered bottom-anchored so a night's
// "shape" becomes legible at a glance — tall front-loaded indigo for
// deep-first cycles, narrow slate dips for wake events, rolling
// purple/sky peaks for later REM-heavy cycles.
//
// Also draws faint cycle dividers (even slices of the night per the
// detected cycle_count) and hourly vertical gridlines so "when" a
// stage happened is spatially anchored instead of being hidden in a
// hover tooltip.
/** Plain-language one-liner interpreting the night. The chart shows
 * the *shape* of sleep; this sentence tells you what to take away from
 * it. Rules are deliberately conservative — only calls out patterns
 * that are clearly present, so it doesn't over-read noise. */
function buildSleepStory(snap: SleepSnapshot): string | null {
  const stages = snap.stages;
  const total =
    stages.light_min + stages.deep_min + stages.rem_min;
  if (total <= 0) return null;

  const parts: string[] = [];

  // 1) Was deep sleep front-loaded? (Clinically the expected shape.)
  //    Split the night in half and compare deep minutes in each.
  const t0 = new Date(snap.sleep_start).getTime();
  const t1 = new Date(snap.sleep_end).getTime();
  const midpoint = t0 + (t1 - t0) / 2;
  let firstDeep = 0;
  let secondDeep = 0;
  for (const h of snap.hypnogram) {
    if (h.stage !== "Deep") continue;
    const hs = new Date(h.start).getTime();
    const he = new Date(h.end).getTime();
    const first = Math.max(0, Math.min(midpoint, he) - Math.max(t0, hs));
    const second = Math.max(0, Math.min(t1, he) - Math.max(midpoint, hs));
    firstDeep += first;
    secondDeep += second;
  }
  if (firstDeep > 0 && firstDeep > secondDeep * 1.8) {
    parts.push("Deep-heavy start");
  } else if (secondDeep > firstDeep * 1.8 && secondDeep > 0) {
    parts.push("Delayed deep onset");
  }

  // 2) Interruption character — driven by measured wake-event count
  //    rather than counting every micro-wake in the hypnogram.
  const wakeEvents = snap.wake_event_count ?? 0;
  if (wakeEvents >= 5) {
    parts.push(`${wakeEvents} wake events`);
  } else if (wakeEvents <= 1) {
    parts.push("uninterrupted");
  }

  // 3) Cycle count framing.
  const cycles = snap.cycle_count;
  if (cycles != null) {
    if (cycles >= 4) parts.push(`${cycles} full cycles`);
    else if (cycles > 0) parts.push(`${cycles} cycle${cycles === 1 ? "" : "s"}`);
  }

  if (parts.length === 0) return null;
  // Capitalize first segment; lowercase rest for flow.
  const first = parts[0];
  const rest = parts.slice(1).map((p) => p.toLowerCase());
  return [first, ...rest].join(" · ");
}

function SleepStoryLine({ snapshot }: { snapshot: SleepSnapshot }) {
  const story = buildSleepStory(snapshot);
  if (!story) return null;
  return (
    <p className="text-xs text-zinc-300 leading-snug">
      {story}
    </p>
  );
}

function HypnogramStrip({
  hypnogram,
  cycleCount,
  onClick,
}: {
  hypnogram: HypnogramEntry[];
  cycleCount?: number | null;
  onClick?: () => void;
}) {
  return (
    <SkylineHypnogram
      hypnogram={hypnogram}
      heightClass="h-28"
      vbWidth={400}
      vbHeight={120}
      padding={{ l: 30, r: 6, t: 10, b: 16 }}
      cycleCount={cycleCount ?? null}
      showStageLabels
      showHourTicks
      showCycleDividers
      showBaseline
      onClick={onClick}
      ariaLabel="Open hypnogram in close-up view"
    />
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

// Compact two-column table of today's events: 24h time | event name.
// Collapses consecutive duplicates (e.g. back-to-back BatteryLevel).
// 24h time (e.g. "14:30") keeps the row to one line and tabular-nums
// aligns all rows vertically.
function EventsList({ events }: { events: EventLite[] }) {
  if (events.length === 0) return null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
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
      <table className="text-[11px] text-zinc-300 tabular-nums">
        <tbody>
          {todayEvents.map((e, i) => (
            <tr key={i}>
              <td className="text-zinc-500 pr-3 whitespace-nowrap">
                {fmt(e.timestamp)}
              </td>
              <td className="whitespace-nowrap">{e.event_name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Score components as 5 stacked horizontal rows, each: label | bar | value.
// Avoids the label-truncation issue of a 5-column grid at tray width.
function ScoreComponentBars({ c }: { c: ScoreComponentsBreakdown }) {
  const items: [string, number, string][] = [
    ["Sufficiency", c.sufficiency, "bg-emerald-500"],
    ["Efficiency", c.efficiency, "bg-blue-500"],
    ["Restorative", c.restorative, "bg-violet-500"],
    ["Consistency", c.consistency, "bg-amber-500"],
    ["Sleep stress", c.sleep_stress, "bg-teal-500"],
  ];
  return (
    <div className="flex flex-col gap-1">
      {items.map(([label, value, bg]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-[72px] text-[10px] text-zinc-500 flex-shrink-0">
            {label}
          </span>
          <div className="flex-1 h-1 rounded-full bg-zinc-900 overflow-hidden">
            <div
              className={`h-full ${bg}`}
              style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
            />
          </div>
          <span className="w-6 text-right text-[10px] text-zinc-300 tabular-nums flex-shrink-0">
            {Math.round(value)}
          </span>
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
  lo: number;  // 10th percentile — typical low
  avg: number;
  hi: number;  // 90th percentile — typical high
  count: number;
} | null;

// Percentile on an ascending-sorted array using linear interpolation.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function binSeries(
  series: { t: string; b: number }[],
  scale: TimeScale,
): Bin[] {
  const now = Date.now();
  const windowStart = now - scale.hours * 3600_000;
  const binMs = scale.binMinutes * 60_000;
  // Collect raw samples per bin, then compute percentiles in a second
  // pass. Raw min/max over a 60-min bucket (~3600 samples at 1 Hz) is
  // dominated by single-sample artifacts — a brief motion spike pulls
  // max to 107 even if 95% of the hour is between 70 and 92.
  const buckets: number[][] = Array.from({ length: scale.bins }, () => []);

  for (const pt of series) {
    const ts = new Date(pt.t).getTime();
    if (ts < windowStart || ts > now) continue;
    const idx = Math.min(
      Math.floor((ts - windowStart) / binMs),
      scale.bins - 1,
    );
    buckets[idx].push(pt.b);
  }

  return buckets.map((samples, idx) => {
    if (samples.length === 0) return null;
    samples.sort((a, b) => a - b);
    const avg =
      samples.reduce((sum, v) => sum + v, 0) / samples.length;
    const binStart = new Date(windowStart + idx * binMs);
    return {
      label: binStart.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      lo: percentile(samples, 0.10),
      avg,
      hi: percentile(samples, 0.90),
      count: samples.length,
    };
  });
}

/** Heart-rate area chart.
 *
 * Visualization pattern borrowed from Whoop / Garmin / Apple Health:
 * a filled band between the p10 and p90 of each time bin (showing how
 * variable HR was in that window), with a line tracing the avg on top.
 * A wide band means HR was all over the place (movement, stress); a
 * narrow band means it was steady.
 *
 * Previous version used solid single-color bars with height = avg bpm,
 * which hid all variability information and used a loud 5-color ramp
 * that fought with everything else in the UI. */
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

  // Y-axis bounds with a bit of headroom so traces don't graze edges.
  const yMinRaw = Math.min(...filled.map((b) => b.lo));
  const yMaxRaw = Math.max(...filled.map((b) => b.hi));
  const yPad = Math.max(2, (yMaxRaw - yMinRaw) * 0.1);
  const yLow = Math.max(0, Math.floor(yMinRaw - yPad));
  const yHigh = Math.ceil(yMaxRaw + yPad);

  // Resting HR proxy: the overall p10 of the window. Drawn as a dashed
  // reference line so elevated stretches are obvious at a glance.
  const restingHr = Math.round(yMinRaw);

  const VB_W = 400;
  const VB_H = 96;
  const padL = 22;
  const padR = 4;
  const padT = 6;
  const padB = 6;
  const chartW = VB_W - padL - padR;
  const chartH = VB_H - padT - padB;

  const xFor = (i: number) =>
    padL + (i / Math.max(bins.length - 1, 1)) * chartW;
  const yFor = (v: number) =>
    padT + (1 - (v - yLow) / Math.max(yHigh - yLow, 1)) * chartH;

  // Split the bins into contiguous runs of non-null so we can render
  // each run as its own path (gaps in data don't get bridged across).
  const runs: number[][] = [];
  let current: number[] = [];
  bins.forEach((b, i) => {
    if (b === null) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push(i);
    }
  });
  if (current.length) runs.push(current);

  const fmt = (n: number) => n.toFixed(1);
  const areaPath = runs
    .map((run) => {
      const forward = run
        .map((i, n) => {
          const b = bins[i]!;
          return `${n === 0 ? "M" : "L"} ${fmt(xFor(i))} ${fmt(yFor(b.hi))}`;
        })
        .join(" ");
      const back = run
        .slice()
        .reverse()
        .map((i) => {
          const b = bins[i]!;
          return `L ${fmt(xFor(i))} ${fmt(yFor(b.lo))}`;
        })
        .join(" ");
      return `${forward} ${back} Z`;
    })
    .join(" ");
  const avgPath = runs
    .map((run) =>
      run
        .map((i, n) => {
          const b = bins[i]!;
          return `${n === 0 ? "M" : "L"} ${fmt(xFor(i))} ${fmt(yFor(b.avg))}`;
        })
        .join(" "),
    )
    .join(" ");

  // X-axis labels (5 evenly spaced across the window).
  const windowStart = Date.now() - scale.hours * 3600_000;
  const labels = Array.from({ length: 5 }, (_, i) => {
    const ts = windowStart + (i / 4) * scale.hours * 3600_000;
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  });

  // Hover: invisible wide hit-rects, one per bin, that set `hovered`.
  const hoveredIdx = hovered ? bins.findIndex((b) => b === hovered) : -1;

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
        {hovered ? (
          <span className="text-[9px] text-zinc-400 tabular-nums">
            {hovered.label} ·{" "}
            <span className="text-zinc-200">{Math.round(hovered.avg)}</span>{" "}
            <span className="text-zinc-600">
              ({Math.round(hovered.lo)}–{Math.round(hovered.hi)})
            </span>
            <span className="text-zinc-600 ml-1">bpm</span>
          </span>
        ) : (
          <span className="text-[9px] text-zinc-500 tabular-nums">
            range <span className="text-zinc-300">{yLow}</span>
            <span className="text-zinc-600 mx-0.5">–</span>
            <span className="text-zinc-300">{yHigh}</span> bpm
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-24"
        onMouseLeave={() => setHovered(null)}
      >
        {/* Y-axis labels (just bounds) */}
        <text
          x={padL - 3}
          y={yFor(yHigh) + 3}
          fontSize={7}
          fill="var(--color-zinc-600)"
          textAnchor="end"
          style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
        >
          {yHigh}
        </text>
        <text
          x={padL - 3}
          y={yFor(yLow) + 1}
          fontSize={7}
          fill="var(--color-zinc-600)"
          textAnchor="end"
          style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
        >
          {yLow}
        </text>

        {/* Resting HR reference line */}
        {restingHr > yLow && (
          <g>
            <line
              x1={padL}
              y1={yFor(restingHr)}
              x2={VB_W - padR}
              y2={yFor(restingHr)}
              stroke="var(--color-zinc-700)"
              strokeWidth={0.5}
              strokeDasharray="3,2"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={VB_W - padR - 1}
              y={yFor(restingHr) - 1.5}
              fontSize={6.5}
              fill="var(--color-zinc-600)"
              textAnchor="end"
              style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
            >
              rest {restingHr}
            </text>
          </g>
        )}

        {/* Range band (p10–p90) */}
        <path d={areaPath} fill="#fb7185" fillOpacity={0.18} />

        {/* Avg line */}
        <path
          d={avgPath}
          stroke="#f43f5e"
          strokeWidth={1.25}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />

        {/* Hover cursor */}
        {hoveredIdx >= 0 && bins[hoveredIdx] && (
          <g>
            <line
              x1={xFor(hoveredIdx)}
              y1={padT}
              x2={xFor(hoveredIdx)}
              y2={VB_H - padB}
              stroke="var(--color-zinc-500)"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={xFor(hoveredIdx)}
              cy={yFor(bins[hoveredIdx]!.avg)}
              r={2}
              fill="#fb7185"
              stroke="var(--app-bg)"
              strokeWidth={0.75}
            />
          </g>
        )}

        {/* Invisible hit-rects for hover */}
        {bins.map((bin, i) => {
          if (bin === null) return null;
          const half =
            i === 0 || i === bins.length - 1
              ? chartW / Math.max(bins.length - 1, 1) / 2
              : chartW / Math.max(bins.length - 1, 1) / 2;
          return (
            <rect
              key={i}
              x={xFor(i) - half}
              y={padT}
              width={half * 2}
              height={chartH}
              fill="transparent"
              onMouseEnter={() => setHovered(bin)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </svg>
      <div
        className="flex justify-between text-[9px] text-zinc-600 tabular-nums"
        style={{ paddingLeft: `${(padL / VB_W) * 100}%` }}
      >
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

// Identity palette — one color per ring. Each ring keeps its own hue
// regardless of score, so a user can learn "teal = recovery, indigo =
// sleep, fuchsia = HRV" at a glance. Band status is shown separately
// via a colored dot so we don't conflate "which metric" with "how good."
//
// Colors are chosen with these constraints:
//   - Distinct hues (teal / indigo / fuchsia sit ~120° apart on the wheel).
//   - Saturated enough to remain legible on dark backgrounds.
//   - Tailwind's 400/500 shades — readable on both dark themes and any
//     future light theme without changes, since they sit in the
//     mid-luminance range.
const RING_PALETTE = {
  recovery: {
    arc: "#2dd4bf", // teal-400
    track: "rgba(45, 212, 191, 0.15)",
    text: "#5eead4", // teal-300
  },
  sleep: {
    arc: "#818cf8", // indigo-400
    track: "rgba(129, 140, 248, 0.15)",
    text: "#a5b4fc", // indigo-300
  },
  hrv: {
    arc: "#e879f9", // fuchsia-400
    track: "rgba(232, 121, 249, 0.15)",
    text: "#f0abfc", // fuchsia-300
  },
} as const;

type RingKey = keyof typeof RING_PALETTE;

// Band = qualitative status from score. Used only for the status dot
// below each ring, not for the ring arc itself.
const BAND_DOT = {
  green: "#10b981", // emerald-500
  yellow: "#f59e0b", // amber-500
  red: "#ef4444", // red-500
} as const;

function bandFromScore(score: number): "red" | "yellow" | "green" {
  if (score < 34) return "red";
  if (score < 67) return "yellow";
  return "green";
}

function RingGauge({
  label,
  score,
  band,
  palette,
  size = 80,
  subLabel,
  title,
}: {
  label: string;
  /** 0–100. `null` renders a muted placeholder ring. */
  score: number | null;
  band: "red" | "yellow" | "green";
  palette: RingKey;
  size?: number;
  subLabel?: React.ReactNode;
  title?: string;
}) {
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = score == null ? 0 : Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);
  const colors = RING_PALETTE[palette];

  return (
    <div className="flex flex-col items-center gap-1" title={title}>
      <div
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          backgroundColor: score == null ? "transparent" : colors.track,
        }}
      >
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="currentColor"
            className="text-zinc-800/80"
            strokeWidth={stroke}
            fill="none"
          />
          {score != null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={colors.arc}
              strokeWidth={stroke}
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-xl font-semibold tabular-nums"
            style={{ color: score == null ? undefined : colors.text }}
          >
            {score == null ? "--" : Math.round(score)}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-zinc-500">
            {label}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1.5 min-h-[14px]">
        {score != null && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: BAND_DOT[band] }}
            aria-label={`${band} band`}
          />
        )}
        {subLabel &&
          (typeof subLabel === "string" ? (
            <span className="text-[10px] text-zinc-500 tabular-nums">
              {subLabel}
            </span>
          ) : (
            subLabel
          ))}
      </div>
    </div>
  );
}

function RecoveryCard({
  r,
  sleepPerformance,
}: {
  r: RecoverySection;
  sleepPerformance: number | null;
}) {
  const driverLabel: Record<RecoverySection["dominant_driver"], string> = {
    hrv: "low HRV",
    rhr: "elevated resting HR",
    sleep: "poor sleep",
    rr: "respiratory rate off baseline",
    skin_temp: "skin temp deviation",
    none: "no single driver",
  };

  // HRV ring: age-normed absolute score (where does tonight's HRV sit
  // against published population RMSSD percentiles for your age?). The
  // baseline z-score becomes a trend annotation below the ring. If no
  // DOB is set, score is null and the ring shows just the raw ms value.
  const hrvScore = r.age_normed_hrv_score;
  const hrvBand =
    hrvScore != null ? bandFromScore(hrvScore) : ("yellow" as const);
  const hrvRawMs = r.hrv_rmssd_ms;
  const hrvSubLabel = (() => {
    const parts: string[] = [];
    if (hrvRawMs != null) parts.push(`${Math.round(hrvRawMs)} ms`);
    if (r.z_hrv != null) {
      const sign = r.z_hrv >= 0 ? "+" : "";
      parts.push(`${sign}${r.z_hrv.toFixed(2)}σ`);
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  })();
  const hrvTitle =
    hrvScore != null
      ? "HRV scored against published RMSSD norms for your age. 50 = typical, 85 = 90th percentile."
      : "HRV ring shows raw RMSSD. Set your date of birth in Settings to get an age-normed 0–100 score.";

  const sleepBand =
    sleepPerformance != null ? bandFromScore(sleepPerformance) : ("yellow" as const);

  // Recovery ring's caption: amber Calibrating pill while still building
  // baseline history, otherwise a quiet "vs N-night baseline" footnote.
  // Lives inside the ring's tile (rather than as an orphaned flex row
  // below the row of rings) so the pairing reads visually.
  const recoveryCaption = r.calibrating ? (
    <span
      className="rounded-full bg-amber-500/20 border border-amber-500/30 px-1.5 py-[1px] text-[9px] uppercase text-amber-300 whitespace-nowrap tabular-nums"
      title={`Calibrating: baseline uses ${r.baseline_window_nights} of 14 nights. Accuracy improves as more data accumulates.`}
    >
      {r.baseline_window_nights}/14 nights
    </span>
  ) : (
    <span className="text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">
      vs {r.baseline_window_nights}-night baseline
    </span>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-zinc-400">
        {r.dominant_driver === "none"
          ? "All metrics near personal baseline."
          : `Main driver: ${driverLabel[r.dominant_driver]}.`}
      </p>

      <div className="grid grid-cols-3 gap-2">
        <RingTile>
          <RingGauge
            label="Recovery"
            score={r.score}
            band={r.band}
            palette="recovery"
            size={96}
            subLabel={recoveryCaption}
            title="Composite readiness: HRV + RHR + sleep + respiratory rate + skin temp, weighted against your personal baseline."
          />
        </RingTile>
        <RingTile>
          <RingGauge
            label="Sleep"
            score={sleepPerformance}
            band={sleepBand}
            palette="sleep"
            size={96}
            subLabel={
              sleepPerformance != null ? (
                <span className="text-[10px] text-zinc-500">last night</span>
              ) : undefined
            }
            title="Sleep performance — sufficiency + efficiency + restorative stages + consistency + stress."
          />
        </RingTile>
        <RingTile>
          <RingGauge
            label="HRV"
            score={hrvScore}
            band={hrvBand}
            palette="hrv"
            size={96}
            subLabel={hrvSubLabel}
            title={hrvTitle}
          />
        </RingTile>
      </div>

      <BaselineDeltaList r={r} />
    </div>
  );
}

/** Bordered ring "card". The light border around each ring + caption
 *  visually pairs them so the caption is unambiguously about that ring. */
function RingTile({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/30 p-2.5 flex justify-center">
      {children}
    </div>
  );
}

/** Per-metric "today vs your baseline" rows. Each row has the metric
 *  name, a centered-zero deviation bar (-2σ to +2σ), and the σ value
 *  color-coded to "better" (positive) vs "worse" (negative). The visual
 *  bar lets you compare metrics at a glance without parsing numbers. */
function BaselineDeltaList({ r }: { r: RecoverySection }) {
  const candidates: { label: string; z: number | null }[] = [
    { label: "HRV", z: r.z_hrv },
    { label: "Resting HR", z: r.z_rhr },
    { label: "Sleep", z: r.z_sleep },
    { label: "Respiratory", z: r.z_rr },
    { label: "Skin temp", z: r.z_skin_temp },
  ];
  const rows = candidates.filter(
    (m): m is { label: string; z: number } => m.z != null,
  );

  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Today vs your baseline
        </span>
        <span
          className="text-[9px] text-zinc-600"
          title="Standard deviations from your rolling personal baseline. Positive = better than usual."
        >
          σ = std-dev from baseline
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <BaselineDeltaRow key={row.label} label={row.label} z={row.z} />
        ))}
      </div>
    </div>
  );
}

function BaselineDeltaRow({ label, z }: { label: string; z: number }) {
  // Bar maps the z-score onto a -2σ → +2σ axis with the baseline at the
  // center. Past ±2σ values clamp to the bar edges so an outlier doesn't
  // distort the relative reading of other rows.
  const max = 2;
  const clamped = Math.max(-max, Math.min(max, z));
  const positive = z >= 0;
  // Convert clamped z into a fill from the center tick to the marker.
  const centerPct = 50;
  const offsetPct = (Math.abs(clamped) / max) * 50;
  const leftPct = positive ? centerPct : centerPct - offsetPct;
  const widthPct = offsetPct;
  const fillCls = positive ? "bg-emerald-500/60" : "bg-rose-500/60";
  const valueCls = positive ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-[11px]">
      <span className="text-zinc-400 truncate">{label}</span>
      <div className="relative h-1.5 rounded-full bg-zinc-900">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-700" />
        <div
          className={`absolute top-0 bottom-0 rounded-full ${fillCls}`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
      </div>
      <span className={`text-right tabular-nums ${valueCls}`}>
        {positive ? "+" : ""}
        {z.toFixed(2)}σ
      </span>
    </div>
  );
}

function Section({
  title,
  children,
  className = "",
  editMode = false,
  onHide,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  /** When true, render the iOS-style minus badge in the top-left and a
   *  subtle ring around the section so it reads as "in edit mode." */
  editMode?: boolean;
  onHide?: () => void;
}) {
  return (
    <section
      className={
        "relative flex flex-col gap-3 " +
        (editMode
          ? "rounded-md ring-1 ring-zinc-700/60 bg-zinc-900/20 p-3 -m-1 "
          : "") +
        className
      }
    >
      {editMode && onHide && (
        <button
          onClick={onHide}
          className="absolute -top-2 -left-2 z-10 w-5 h-5 rounded-full bg-rose-500 text-white text-xs font-bold shadow-md flex items-center justify-center leading-none hover:bg-rose-600 transition-colors"
          aria-label={`Hide ${title} widget`}
          title={`Hide ${title}`}
        >
          −
        </button>
      )}
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
  dob: string | null;
  allow_surplus_banking: boolean;
};

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sleepSnapshot, setSleepSnapshot] = useState<SleepSnapshot | null>(null);
  const [dailySnapshot, setDailySnapshot] = useState<DailySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStage, setSyncStage] = useState<SyncStage | null>(null);
  // Timestamp of the most recent sync-related event from the backend. The
  // watchdog effect below uses this to auto-recover the UI if the backend
  // ever stops emitting events while `syncing` is true (last-resort defense
  // against hangs that bypass the 15-minute hard timeout).
  const syncActivityAtRef = useRef<number>(Date.now());
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => {
    return (localStorage.getItem("tempUnit") as TempUnit) || "C";
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("theme") as Theme | null;
    return saved && THEME_OPTIONS.some((o) => o.value === saved)
      ? saved
      : "monokai";
  });
  const [debugMode, setDebugMode] = useState<boolean>(() => {
    return localStorage.getItem("debugMode") === "true";
  });
  const [hiddenSections, setHiddenSections] = useState<SectionId[]>(() => {
    try {
      const raw = localStorage.getItem("hiddenSections");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.filter((s): s is SectionId => s in SECTION_LABELS)
        : [];
    } catch {
      return [];
    }
  });
  const [editMode, setEditMode] = useState(false);
  const isSectionHidden = (id: SectionId) => hiddenSections.includes(id);
  const hideSection = (id: SectionId) =>
    setHiddenSections((prev) => (prev.includes(id) ? prev : [...prev, id]));
  const showSection = (id: SectionId) =>
    setHiddenSections((prev) => prev.filter((s) => s !== id));
  const [deviceName, setDeviceName] = useState<string>("");
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [syncInterval, setSyncInterval] = useState<number>(0);
  const [presenceInterval, setPresenceInterval] = useState<number>(2);
  const [dobInput, setDobInput] = useState<string>("");
  const [autostart, setAutostart] = useState<boolean>(false);
  const [allowSurplusBanking, setAllowSurplusBanking] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanResults, setScanResults] = useState<DiscoveredDevice[]>([]);
  const [downloadCount, setDownloadCount] = useState<number>(0);
  const [alarmInput, setAlarmInput] = useState<string>("07:00");
  const [alarmBusy, setAlarmBusy] = useState<boolean>(false);
  const [alarmInputTouched, setAlarmInputTouched] = useState<boolean>(false);
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<View>("now");
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem("displayMode") as Mode | null;
    return saved === "expanded" || saved === "compact" ? saved : "compact";
  });
  const [zoomedHypnogram, setZoomedHypnogram] = useState<{
    title: string;
    subtitle?: string;
    hypnogram: HypnogramEntry[];
    cycleCount: number | null;
  } | null>(null);
  const [liveActive, setLiveActive] = useState(false);
  const [liveStarting, setLiveStarting] = useState(false);
  const [liveBpm, setLiveBpm] = useState<number | null>(null);
  const [liveLastAt, setLiveLastAt] = useState<string | null>(null);
  // tick increments every 30s so the "Next sync in Xm" label re-renders
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(i);
  }, []);
  void tick;

  // Resize the window to match the display mode. Compact = tray-sized;
  // expanded = wide multi-column dashboard. Independent of which view
  // (Now / History) is active, so toggling mode keeps you in place.
  useEffect(() => {
    const { w, h } = MODE_WINDOW_SIZE[mode];
    getCurrentWindow()
      .setSize(new LogicalSize(w, h))
      .catch(() => {
        // non-fatal: capability may not be granted in some builds
      });
    localStorage.setItem("displayMode", mode);
  }, [mode]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("debugMode", debugMode ? "true" : "false");
  }, [debugMode]);

  useEffect(() => {
    localStorage.setItem("hiddenSections", JSON.stringify(hiddenSections));
  }, [hiddenSections]);

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

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

  const saveDob = async (iso: string) => {
    setDobInput(iso);
    // Accept YYYY-MM-DD or empty. Reject obvious garbage (backend will
    // double-check format and return an error otherwise).
    if (iso !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    try {
      await invoke("set_dob", { iso: iso === "" ? null : iso });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const saveAllowSurplusBanking = async (enabled: boolean) => {
    setAllowSurplusBanking(enabled);
    try {
      await invoke("set_allow_surplus_banking", { enabled });
    } catch (e) {
      setError(String(e));
      setAllowSurplusBanking(!enabled);
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
        setDobInput(cfg.dob ?? "");
        setAllowSurplusBanking(cfg.allow_surplus_banking ?? false);
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
          syncActivityAtRef.current = Date.now();
          setSyncStage(e.payload);
          setSyncing(e.payload !== "done");
          if (e.payload === "scanning") {
            setDownloadCount(0);
          }
        })
      );
      unlistenFns.push(
        await listen<number>("sync:download_progress", (e) => {
          syncActivityAtRef.current = Date.now();
          setDownloadCount(e.payload);
        })
      );
      unlistenFns.push(
        await listen<SyncReport>("sync:complete", (e) => {
          syncActivityAtRef.current = Date.now();
          setLastSync(e.payload);
          setSyncing(false);
          setSyncStage(null);
          setDownloadCount(0);
          refresh();
        })
      );
      unlistenFns.push(
        await listen<string>("sync:error", (e) => {
          syncActivityAtRef.current = Date.now();
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
      unlistenFns.push(
        await listen("live:starting", () => {
          setLiveStarting(true);
        })
      );
      unlistenFns.push(
        await listen("live:started", () => {
          setLiveStarting(false);
          setLiveActive(true);
        })
      );
      unlistenFns.push(
        await listen("live:stopped", () => {
          setLiveStarting(false);
          setLiveActive(false);
        })
      );
      unlistenFns.push(
        await listen<string>("live:error", (e) => {
          setLiveStarting(false);
          setLiveActive(false);
          setError(e.payload);
        })
      );
      unlistenFns.push(
        await listen<{ bpm: number; raw_hex: string; ts: string }>(
          "live_sample",
          (e) => {
            setLiveBpm(e.payload.bpm);
            setLiveLastAt(e.payload.ts);
          }
        )
      );
    })();
    return () => unlistenFns.forEach((fn) => fn());
  }, [refresh]);

  // Last-resort watchdog: if `syncing` is true but no sync event has arrived
  // for WATCHDOG_MS, assume the backend hung and reset the UI. The backend's
  // 15-minute hard timeout and per-attempt retry logic should make this
  // unreachable in normal operation — this exists so a regression there can't
  // leave the app permanently stuck on "Downloading…".
  useEffect(() => {
    if (!syncing) return;
    const WATCHDOG_MS = 20 * 60 * 1000;
    const CHECK_INTERVAL_MS = 30_000;
    syncActivityAtRef.current = Date.now();
    const check = setInterval(() => {
      if (Date.now() - syncActivityAtRef.current > WATCHDOG_MS) {
        console.warn(
          "openwhoop: sync watchdog fired — no events for 20 minutes, resetting UI"
        );
        setSyncing(false);
        setSyncStage(null);
        setDownloadCount(0);
        setError(
          "Sync stopped responding. Try again — if it persists, restart the app."
        );
      }
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(check);
  }, [syncing]);

  const onCancelSync = async () => {
    try {
      await invoke("cancel_sync");
    } catch (e) {
      setError(String(e));
    }
  };

  const onToggleLiveStream = async () => {
    try {
      if (liveActive || liveStarting) {
        await invoke("stop_live_stream");
      } else {
        setLiveStarting(true);
        setLiveBpm(null);
        setLiveLastAt(null);
        await invoke("start_live_stream");
      }
    } catch (e) {
      setLiveStarting(false);
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
  const r = snapshot?.recovery;

  return (
    <main
      className="flex flex-col h-screen overflow-y-auto px-6 py-5 gap-6 text-zinc-100"
      style={{ scrollbarGutter: "stable" }}
    >
      <header className="flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">OpenWhoop</h1>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-1">
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
            {/* If the strap is on-wrist, presence is implied (it's with
                you, so it's in range). Only surface the Presence pill
                when we don't already know it's being worn — i.e. wear
                status is unknown or the strap is off-wrist. */}
            {snapshot?.battery?.is_worn !== true && (
              <PresencePill seenAt={snapshot?.strap_seen_at ?? null} />
            )}
          </div>
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
            onClick={() =>
              setMode((m) => (m === "compact" ? "expanded" : "compact"))
            }
            className="rounded-md border border-zinc-800 hover:border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            title={
              mode === "compact"
                ? "Expand window into multi-column dashboard"
                : "Collapse to compact tray window"
            }
            aria-label={mode === "compact" ? "Expand view" : "Collapse view"}
          >
            {mode === "compact" ? "⤢" : "⤡"}
          </button>
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
              className="rounded-md bg-rose-500/90 hover:bg-rose-500 active:bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Sync now
            </button>
          )}
        </div>
      </header>

      <nav className="flex items-center gap-1 -mt-2 text-[11px]">
        {(["now", "history"] as const).map((v) => (
          <button
            key={v}
            onClick={() => {
              setView(v);
              if (v !== "now") setEditMode(false);
            }}
            className={
              "rounded-full px-3 py-1 uppercase tracking-wider transition-colors " +
              (view === v
                ? "bg-zinc-800/80 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300")
            }
          >
            {v === "now" ? "Now" : "History"}
          </button>
        ))}
        {view === "now" && (
          <button
            onClick={() => setEditMode((v) => !v)}
            className={
              "ml-auto rounded-full px-3 py-1 uppercase tracking-wider transition-colors " +
              (editMode
                ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                : "text-zinc-500 hover:text-zinc-300 border border-transparent")
            }
            title={
              editMode
                ? "Done customizing widgets"
                : "Show or hide Now-page widgets"
            }
          >
            {editMode ? "Done" : "Customize"}
          </button>
        )}
      </nav>

      {showSettings && (
        <div
          className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/50 backdrop-blur-sm p-6"
          onClick={() => setShowSettings(false)}
        >
        <div
          className="w-full max-w-md flex flex-col gap-4 rounded-lg border border-zinc-800 bg-[var(--app-bg)] p-4 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
            <button
              onClick={() => setShowSettings(false)}
              className="text-zinc-500 hover:text-zinc-200 transition-colors text-xl leading-none px-1"
              aria-label="Close settings"
            >
              ×
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">
              Theme
            </label>
            <div className="flex gap-1">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  title={opt.hint}
                  className={
                    "flex-1 rounded border px-2 py-1.5 text-xs transition-colors " +
                    (theme === opt.value
                      ? "border-zinc-600 bg-zinc-800/70 text-zinc-100"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

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

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">
              Date of birth
            </label>
            <input
              type="date"
              value={dobInput}
              onChange={(e) => saveDob(e.target.value)}
              className="rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
            />
            <p className="text-[10px] text-zinc-600">
              Used to score your HRV against age-matched population norms.
              Stored locally only.
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

          <label className="flex items-start justify-between cursor-pointer gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                Sleep banking
              </span>
              <span className="text-[10px] text-zinc-600 leading-snug">
                When on, extra sleep over recent days reduces tonight's need
                (Rupp 2009). WHOOP doesn't do this; default off.
              </span>
            </div>
            <input
              type="checkbox"
              checked={allowSurplusBanking}
              onChange={(e) => saveAllowSurplusBanking(e.target.checked)}
              className="accent-rose-500 mt-0.5"
            />
          </label>

          <label className="flex items-start justify-between cursor-pointer gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                Developer debugger
              </span>
              <span className="text-[10px] text-zinc-600 leading-snug">
                Shows the raw "Recent events" stream and other internal
                instrumentation. Off by default.
              </span>
            </div>
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
              className="accent-rose-500 mt-0.5"
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

      {view === "history" && (
        <HistoryView visible={view === "history"} mode={mode} />
      )}

      {view === "now" && (
      <div
        className={
          mode === "expanded"
            ? "grid grid-cols-2 gap-x-8 gap-y-6 auto-rows-min"
            : "flex flex-col gap-6"
        }
      >
      {!isSectionHidden("recovery") && (
      <Section
        title="Recovery"
        className={mode === "expanded" ? "col-span-2" : ""}
        editMode={editMode}
        onHide={() => hideSection("recovery")}
      >
        {r ? (
          <RecoveryCard
            r={r}
            sleepPerformance={sleepSnapshot?.performance_score ?? null}
          />
        ) : (
          <p className="text-xs text-zinc-500">
            Need ≥3 prior nights of sleep data to compute recovery. Keep
            wearing the strap through the night.
          </p>
        )}
      </Section>
      )}

      {!isSectionHidden("today") && (
      <Section title="Today" editMode={editMode} onHide={() => hideSection("today")}>
        <div className="flex items-center justify-end -mt-1 mb-1">
          <button
            onClick={onToggleLiveStream}
            disabled={liveStarting && !liveActive}
            className={
              "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors " +
              (liveActive
                ? "bg-rose-500/90 hover:bg-rose-500 text-white"
                : liveStarting
                ? "bg-zinc-800 text-zinc-400"
                : "border border-zinc-800 hover:border-zinc-600 text-zinc-400 hover:text-zinc-200")
            }
            title={
              liveActive
                ? "Stop live stream"
                : "Stream heart rate in real time from the strap"
            }
          >
            {liveActive
              ? "● Live · Stop"
              : liveStarting
              ? "Starting…"
              : "Go live"}
          </button>
        </div>
        {t && t.sample_count > 0 ? (
          <>
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-semibold tabular-nums">
                {liveActive ? liveBpm ?? "--" : t.current_bpm ?? "--"}
              </span>
              <span className="text-xs text-zinc-500">bpm</span>
              {liveActive && (
                <span className="rounded-full bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-rose-300 animate-pulse">
                  live
                </span>
              )}
              <span className="text-[10px] text-zinc-600 ml-auto">
                {liveActive
                  ? liveLastAt
                    ? `live · last ${formatClock(liveLastAt)}`
                    : "waiting for first packet…"
                  : `${t.sample_count} samples · last ${formatClock(t.last_seen)}`}
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
        ) : liveActive ? (
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums">
              {liveBpm ?? "--"}
            </span>
            <span className="text-xs text-zinc-500">bpm</span>
            <span className="rounded-full bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-rose-300 animate-pulse">
              live
            </span>
            <span className="text-[10px] text-zinc-600 ml-auto">
              {liveLastAt
                ? `live · last ${formatClock(liveLastAt)}`
                : "waiting for first packet…"}
            </span>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            No heart-rate data yet today. Tap <em>Sync now</em>.
          </p>
        )}
      </Section>
      )}

      {!isSectionHidden("latest_sleep") && (
      <Section title="Latest sleep" editMode={editMode} onHide={() => hideSection("latest_sleep")}>
        {s ? (
          <div className="flex flex-col gap-2">
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
              <>
                <SleepStoryLine snapshot={sleepSnapshot} />
                <HypnogramStrip
                  hypnogram={sleepSnapshot.hypnogram}
                  cycleCount={sleepSnapshot.cycle_count}
                  onClick={() =>
                    setZoomedHypnogram({
                      title: s.night,
                      subtitle: `${formatTime(s.start)} → ${formatTime(s.end)}`,
                      hypnogram: sleepSnapshot.hypnogram,
                      cycleCount: sleepSnapshot.cycle_count,
                    })
                  }
                />
              </>
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
                {sleepSnapshot.performance_score != null && (
                  <span title="Overall sleep performance (sufficiency + efficiency + restorative stages + consistency + stress)">
                    Perf{" "}
                    <span className="text-zinc-200">
                      {Math.round(sleepSnapshot.performance_score)}
                    </span>
                  </span>
                )}
                {sleepSnapshot.sleep_need_hours != null && (
                  <span title="Sleep need = baseline + strain + debt adjustments">
                    Need{" "}
                    <span className="text-zinc-200">
                      {sleepSnapshot.sleep_need_hours.toFixed(1)}h
                    </span>
                  </span>
                )}
                {/* Hide if implausible. Per-night need clamps to ≤ 10.5h
                    (MAX_SLEEP_NEED_HOURS), so a per-night avg deficit can't
                    legitimately exceed ~10h — anything larger means upstream
                    staging is mislabeling units somewhere and we'd rather
                    show nothing than a nonsense number like "18.7h/night". */}
                {sleepSnapshot.sleep_debt_hours != null &&
                  sleepSnapshot.sleep_debt_hours > 0.1 &&
                  sleepSnapshot.sleep_debt_hours <= 10 && (
                    <span
                      className={
                        sleepSnapshot.sleep_debt_hours > 1
                          ? "text-amber-400"
                          : undefined
                      }
                      title="Decay-weighted average hours short per night across the last 7 nights (most recent weighted highest)"
                    >
                      Avg deficit{" "}
                      <span
                        className={
                          sleepSnapshot.sleep_debt_hours > 1
                            ? "text-amber-300"
                            : "text-zinc-200"
                        }
                      >
                        {sleepSnapshot.sleep_debt_hours.toFixed(1)}h/night
                      </span>
                    </span>
                  )}
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
      )}

      {!isSectionHidden("week") && (
      <Section title="Last 7 days" editMode={editMode} onHide={() => hideSection("week")}>
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
      )}

      {dailySnapshot && !isSectionHidden("activity") && (
        <Section title="Today's activity" editMode={editMode} onHide={() => hideSection("activity")}>
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
            {debugMode && (
              <EventsList events={dailySnapshot.recent_events} />
            )}
            {dailySnapshot.today_wear_minutes === 0 &&
              dailySnapshot.today_hrv_samples.length === 0 &&
              (!debugMode ||
                dailySnapshot.recent_events.length === 0) && (
                <p className="text-xs text-zinc-500">
                  No data today yet. Run <em>detect-events</em> after a sync.
                </p>
              )}
          </div>
        </Section>
      )}

      {editMode && (
        hiddenSections.length > 0 ? (
          <div
            className={
              "rounded-xl border border-dashed border-zinc-700/60 bg-zinc-950/40 p-3 mt-2 flex flex-col gap-2 " +
              (mode === "expanded" ? "col-span-2" : "")
            }
          >
            <h3 className="text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Available widgets
            </h3>
            <div className="flex flex-wrap gap-2">
              {hiddenSections.map((id) => (
                <button
                  key={id}
                  onClick={() => showSection(id)}
                  className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-200 hover:border-emerald-500/50 hover:bg-zinc-900 transition-colors"
                  title={`Add ${SECTION_LABELS[id]} back to the Now page`}
                >
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 text-white text-xs font-bold leading-none">
                    +
                  </span>
                  {SECTION_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p
            className={
              "text-[11px] text-zinc-600 italic mt-2 " +
              (mode === "expanded" ? "col-span-2" : "")
            }
          >
            All widgets are showing. Click − on any widget to hide it.
          </p>
        )
      )}
      </div>
      )}

      {zoomedHypnogram && (
        <HypnogramModal
          title={zoomedHypnogram.title}
          subtitle={zoomedHypnogram.subtitle}
          hypnogram={zoomedHypnogram.hypnogram}
          cycleCount={zoomedHypnogram.cycleCount}
          onClose={() => setZoomedHypnogram(null)}
        />
      )}
    </main>
  );
}

export default App;
