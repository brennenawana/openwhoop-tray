import { useEffect } from "react";
import type { HypnogramEntry, SleepStage } from "./types";

// Theme-aware stage colors. The CSS variables are defined in App.css and
// flip to darker shades under `[data-theme="light"]` so the bars stay
// legible on near-white backgrounds.
export const STAGE_COLOR: Record<SleepStage, string> = {
  Wake: "var(--stage-wake)",
  Light: "var(--stage-light)",
  REM: "var(--stage-rem)",
  Deep: "var(--stage-deep)",
  Unknown: "var(--stage-unknown)",
};

// Default depth amplitudes for the in-card chart. Gentle so the skyline
// reads as a rolling wave rather than a spiky mountain range.
export const STAGE_DEPTH: Record<SleepStage, number> = {
  Wake: 0.22,
  Light: 0.52,
  REM: 0.72,
  Deep: 1.0,
  Unknown: 0.1,
};

// Slightly stronger contrast for thumbnail row use, where the chart is
// only ~24px tall and needs more vertical pop to read at a glance.
export const STAGE_DEPTH_THUMB: Record<SleepStage, number> = {
  Wake: 0.18,
  Light: 0.42,
  REM: 0.68,
  Deep: 1.0,
  Unknown: 0.08,
};

// Smooth a raw hypnogram by bucketing it into fixed-duration windows
// (default 5 min) and picking each bucket's *dominant* stage (majority
// time). Adjacent same-stage buckets are then merged back together so
// the downstream renderer sees long spans rather than repeated tiles.
export function smoothHypnogram(
  hypnogram: HypnogramEntry[],
  bucketMinutes = 5,
): HypnogramEntry[] {
  if (hypnogram.length === 0) return hypnogram;
  const t0 = new Date(hypnogram[0].start).getTime();
  const t1 = new Date(hypnogram[hypnogram.length - 1].end).getTime();
  if (t1 <= t0) return hypnogram;

  const bucketMs = bucketMinutes * 60_000;
  const numBuckets = Math.max(1, Math.ceil((t1 - t0) / bucketMs));
  const out: HypnogramEntry[] = [];

  for (let i = 0; i < numBuckets; i += 1) {
    const bStart = t0 + i * bucketMs;
    const bEnd = Math.min(t0 + (i + 1) * bucketMs, t1);
    const tallies: Partial<Record<SleepStage, number>> = {};
    for (const seg of hypnogram) {
      const sStart = new Date(seg.start).getTime();
      const sEnd = new Date(seg.end).getTime();
      const oStart = Math.max(bStart, sStart);
      const oEnd = Math.min(bEnd, sEnd);
      if (oEnd > oStart) {
        tallies[seg.stage] = (tallies[seg.stage] ?? 0) + (oEnd - oStart);
      }
    }
    let dominant: SleepStage = "Unknown";
    let maxDur = 0;
    for (const [stage, dur] of Object.entries(tallies) as [
      SleepStage,
      number,
    ][]) {
      if (dur > maxDur) {
        maxDur = dur;
        dominant = stage;
      }
    }
    if (maxDur === 0) continue;
    out.push({
      start: new Date(bStart).toISOString(),
      end: new Date(bEnd).toISOString(),
      stage: dominant,
    });
  }

  const merged: HypnogramEntry[] = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (last && last.stage === b.stage) {
      last.end = b.end;
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface SkylineHypnogramProps {
  hypnogram: HypnogramEntry[];
  /** Tailwind height utility (e.g. "h-6", "h-28", "h-48"). */
  heightClass: string;
  /** Override viewBox dimensions for different aspect ratios. */
  vbWidth?: number;
  vbHeight?: number;
  padding?: { l: number; r: number; t: number; b: number };
  depths?: Record<SleepStage, number>;
  cycleCount?: number | null;
  showStageLabels?: boolean;
  showHourTicks?: boolean;
  showCycleDividers?: boolean;
  showBaseline?: boolean;
  smoothBucketMinutes?: number;
  /** Tailwind background utility (e.g. "bg-zinc-950/60"). */
  background?: string;
  onClick?: () => void;
  className?: string;
  ariaLabel?: string;
  /** Bezier transition radius cap in viewBox units. */
  transitionRadiusCap?: number;
}

/**
 * Smooth-skyline hypnogram. Each stage segment is a path whose left and
 * right edges are quadratic curves landing on the midpoint depth between
 * itself and its neighbor, so adjacent stages meet at a shared (x, y)
 * with no vertical step. First and last segments curve down to the
 * baseline so the night fades in/out.
 *
 * Used both as a thumbnail in the History view and as the full-width
 * Latest Sleep chart on the Now view (with chrome enabled).
 */
export function SkylineHypnogram({
  hypnogram,
  heightClass,
  vbWidth = 400,
  vbHeight = 120,
  padding,
  depths = STAGE_DEPTH,
  cycleCount = null,
  showStageLabels = false,
  showHourTicks = false,
  showCycleDividers = false,
  showBaseline = false,
  smoothBucketMinutes = 5,
  background = "bg-zinc-950/60",
  onClick,
  className = "",
  ariaLabel,
  transitionRadiusCap = 14,
}: SkylineHypnogramProps) {
  const pad = padding ?? { l: 0, r: 0, t: 0, b: 0 };
  const interactiveCls = onClick
    ? " cursor-pointer transition-opacity hover:opacity-90"
    : "";

  if (hypnogram.length === 0) {
    return (
      <div
        className={`${heightClass} w-full rounded ${background} grid place-items-center text-[10px] text-zinc-600 ${className}`}
      >
        no hypnogram
      </div>
    );
  }

  const smoothed = smoothHypnogram(hypnogram, smoothBucketMinutes);
  const padL = pad.l;
  const padR = pad.r;
  const padT = pad.t;
  const padB = pad.b;
  const chartW = vbWidth - padL - padR;
  const chartH = vbHeight - padT - padB;
  const t0 = new Date(smoothed[0].start).getTime();
  const t1 = new Date(smoothed[smoothed.length - 1].end).getTime();
  const tSpan = Math.max(1, t1 - t0);
  const xFor = (t: number) => padL + ((t - t0) / tSpan) * chartW;
  const yForDepth = (d: number) => vbHeight - padB - chartH * d;

  const stageLabels: { stage: SleepStage; label: string }[] = [
    { stage: "Deep", label: "Deep" },
    { stage: "REM", label: "REM" },
    { stage: "Light", label: "Light" },
    { stage: "Wake", label: "Wake" },
  ];

  const startDate = new Date(t0);
  const firstHour = new Date(startDate);
  firstHour.setMinutes(0, 0, 0);
  if (firstHour.getTime() < t0) firstHour.setHours(firstHour.getHours() + 1);
  const hourTicks: number[] = [];
  for (let h = firstHour.getTime(); h <= t1; h += 3600_000) {
    hourTicks.push(h);
  }

  const cycleDividers: number[] = [];
  if (cycleCount && cycleCount > 1) {
    for (let i = 1; i < cycleCount; i += 1) {
      cycleDividers.push(t0 + (tSpan * i) / cycleCount);
    }
  }

  return (
    <svg
      viewBox={`0 0 ${vbWidth} ${vbHeight}`}
      preserveAspectRatio="none"
      className={`w-full ${heightClass} rounded ${background}${interactiveCls} ${className}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      aria-label={ariaLabel}
    >
      {showStageLabels &&
        stageLabels.map(({ stage, label }) => (
          <g key={stage}>
            <line
              x1={padL}
              y1={yForDepth(depths[stage])}
              x2={vbWidth - padR}
              y2={yForDepth(depths[stage])}
              stroke="var(--color-zinc-800)"
              strokeWidth={0.4}
              strokeDasharray="2,4"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={padL - 4}
              y={yForDepth(depths[stage]) + 2.5}
              fontSize={7}
              fill="var(--color-zinc-500)"
              textAnchor="end"
              style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
            >
              {label}
            </text>
          </g>
        ))}

      {showHourTicks &&
        hourTicks.map((t) => (
          <g key={`h${t}`}>
            <line
              x1={xFor(t)}
              y1={padT}
              x2={xFor(t)}
              y2={vbHeight - padB}
              stroke="var(--color-zinc-800)"
              strokeWidth={0.3}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={xFor(t)}
              y={vbHeight - padB + 8}
              fontSize={6.5}
              fill="var(--color-zinc-600)"
              textAnchor="middle"
              style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
            >
              {new Date(t).getHours().toString().padStart(2, "0")}
            </text>
          </g>
        ))}

      {showCycleDividers &&
        cycleDividers.map((t, i) => (
          <line
            key={`c${i}`}
            x1={xFor(t)}
            y1={padT}
            x2={xFor(t)}
            y2={vbHeight - padB}
            stroke="var(--color-zinc-700)"
            strokeWidth={0.6}
            strokeDasharray="1,3"
            vectorEffect="non-scaling-stroke"
          />
        ))}

      {smoothed.map((h, i) => {
        const depth = depths[h.stage] ?? depths.Unknown;
        if (depth <= 0) return null;
        const x0 = xFor(new Date(h.start).getTime());
        const x1v = xFor(new Date(h.end).getTime());
        const yTop = yForDepth(depth);
        const yBase = vbHeight - padB;
        const segW = x1v - x0;

        const prev = smoothed[i - 1];
        const next = smoothed[i + 1];
        const prevDepth = prev ? (depths[prev.stage] ?? 0) : 0;
        const nextDepth = next ? (depths[next.stage] ?? 0) : 0;
        const yLeftMid = yForDepth((depth + prevDepth) / 2);
        const yRightMid = yForDepth((depth + nextDepth) / 2);
        const tw = Math.min(transitionRadiusCap, segW * 0.5);

        const d = [
          `M ${x0} ${yBase}`,
          `L ${x0} ${yLeftMid}`,
          `Q ${x0} ${yTop}, ${x0 + tw} ${yTop}`,
          `L ${x1v - tw} ${yTop}`,
          `Q ${x1v} ${yTop}, ${x1v} ${yRightMid}`,
          `L ${x1v} ${yBase}`,
          "Z",
        ].join(" ");

        return (
          <path
            key={i}
            d={d}
            fill={STAGE_COLOR[h.stage] ?? STAGE_COLOR.Unknown}
            opacity={0.9}
          >
            <title>
              {h.stage} · {fmtTime(h.start)}–{fmtTime(h.end)}
            </title>
          </path>
        );
      })}

      {showBaseline && (
        <line
          x1={padL}
          y1={vbHeight - padB}
          x2={vbWidth - padR}
          y2={vbHeight - padB}
          stroke="var(--color-zinc-700)"
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export interface HypnogramModalProps {
  title: string;
  subtitle?: string;
  hypnogram: HypnogramEntry[];
  cycleCount?: number | null;
  onClose: () => void;
}

/** Full-screen modal showing a hypnogram at increased size for close
 *  inspection. Click backdrop, the × button, or press Esc to dismiss. */
export function HypnogramModal({
  title,
  subtitle,
  hypnogram,
  cycleCount,
  onClose,
}: HypnogramModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/50 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl flex flex-col gap-3 rounded-lg border border-zinc-800 bg-[var(--app-bg)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {subtitle && (
              <span className="text-[10px] text-zinc-500 tabular-nums">
                {subtitle}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition-colors text-xl leading-none px-1"
            aria-label="Close hypnogram"
          >
            ×
          </button>
        </div>
        <SkylineHypnogram
          hypnogram={hypnogram}
          heightClass="h-72"
          vbWidth={800}
          vbHeight={240}
          padding={{ l: 36, r: 8, t: 12, b: 22 }}
          cycleCount={cycleCount ?? null}
          showStageLabels
          showHourTicks
          showCycleDividers
          showBaseline
          transitionRadiusCap={20}
        />
      </div>
    </div>
  );
}
