import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  DailyRollup,
  NightEntry,
  SleepHistory,
} from "./types";
import {
  HypnogramModal,
  SkylineHypnogram,
  STAGE_COLOR,
  STAGE_DEPTH_THUMB,
} from "./Hypnogram";

const ACTIVITY_COLOR = {
  sedentary: "#475569", // slate-600
  light: "#22d3ee", // cyan-400
  moderate: "#fbbf24", // amber-400
  vigorous: "#f472b6", // pink-400
} as const;

const WEAR_COLOR = "#10b981"; // emerald-500
const SCORE_LINE_COLOR = "#fb7185"; // rose-400
const SLEEP_HRV_COLOR = "#818cf8"; // indigo-400
const DAYTIME_HRV_COLOR = "#5eead4"; // teal-300

function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString([], { weekday: "short", day: "numeric" });
}

function fmtDateDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtDateWeekday(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString([], { weekday: "short" });
}

// Returns the "night of" date (YYYY-MM-DD) for a given bedtime, using the
// convention that a post-midnight start belongs to the prior evening.
// Mirrors the backend's `build_sleep_section` shift so labels match.
function nightOf(sleepStart: string): string {
  const t = new Date(sleepStart).getTime() - 12 * 60 * 60 * 1000;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/** Animated skeleton shown while the 14-night history fetch is in flight.
 * Uses Tailwind's `animate-pulse` on placeholder blocks matching the
 * real section layout so the page doesn't look frozen. */
function HistorySkeleton() {
  return (
    <section className="flex flex-col gap-5 pb-4 animate-pulse">
      <div className="flex items-baseline justify-between">
        <div className="h-4 w-32 rounded bg-zinc-800" />
        <div className="h-3 w-28 rounded bg-zinc-800/70" />
      </div>
      {/* Score trend */}
      <div className="flex flex-col gap-1">
        <div className="h-3 w-24 rounded bg-zinc-800/70" />
        <div className="h-14 w-full rounded bg-zinc-900" />
      </div>
      {/* Stage composition */}
      <div className="flex flex-col gap-1">
        <div className="h-3 w-28 rounded bg-zinc-800/70" />
        <div className="h-12 w-full rounded bg-zinc-900" />
      </div>
      {/* Hypnograms */}
      <div className="flex flex-col gap-1">
        <div className="h-3 w-24 rounded bg-zinc-800/70" />
        <div className="flex flex-col gap-[2px]">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-3 w-14 rounded bg-zinc-800/70" />
              <div className="h-6 flex-1 rounded-sm bg-zinc-900" />
              <div className="h-3 w-10 rounded bg-zinc-800/70" />
            </div>
          ))}
        </div>
      </div>
      {/* HRV + wear */}
      <div className="flex flex-col gap-1">
        <div className="h-3 w-24 rounded bg-zinc-800/70" />
        <div className="h-14 w-full rounded bg-zinc-900" />
      </div>
      <div className="flex flex-col gap-1">
        <div className="h-3 w-28 rounded bg-zinc-800/70" />
        <div className="h-10 w-full rounded bg-zinc-900" />
      </div>
      <p className="text-[10px] text-zinc-600 text-center">
        Loading last 14 nights…
      </p>
    </section>
  );
}


/** Score trend — inline SVG line chart with interactive hover tooltip. */
function ScoreTrend({ nights }: { nights: NightEntry[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const points = nights
    .map((n) => ({
      y: n.performance_score ?? null,
      label: nightOf(n.sleep_start),
    }))
    .filter((p): p is { y: number; label: string } => p.y != null)
    .map((p, i) => ({ ...p, x: i }));

  if (points.length < 2) {
    return (
      <p className="text-[10px] text-zinc-600">
        Need at least 2 scored nights to show a trend.
      </p>
    );
  }

  const width = 320;
  const height = 60;
  const pad = 4;
  const ys = points.map((p) => p.y);
  const xMin = 0;
  const xMax = points.length - 1;
  const yMin = Math.min(...ys, 40);
  const yMax = Math.max(...ys, 100);
  const xScale = (x: number) =>
    pad + ((x - xMin) / Math.max(xMax - xMin, 1)) * (width - pad * 2);
  const yScale = (y: number) =>
    pad + (1 - (y - yMin) / Math.max(yMax - yMin, 1)) * (height - pad * 2);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`)
    .join(" ");

  const avg = ys.reduce((s, y) => s + y, 0) / ys.length;
  const latest = points[points.length - 1];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Score trend
        </span>
        <span className="flex items-center gap-3 text-[10px] text-zinc-500 tabular-nums">
          <span>
            latest{" "}
            <span className="text-zinc-200">{latest.y.toFixed(0)}</span>
          </span>
          <span>
            avg <span className="text-zinc-200">{avg.toFixed(0)}</span>
          </span>
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full h-14"
        >
          <line
            x1={pad}
            x2={width - pad}
            y1={yScale(avg)}
            y2={yScale(avg)}
            stroke="var(--color-zinc-700)"
            strokeDasharray="2,2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path}
            stroke={SCORE_LINE_COLOR}
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
          {points.map((p, i) => (
            <g key={i}>
              {/* enlarged invisible hit area for easier hovering */}
              <circle
                cx={xScale(p.x)}
                cy={yScale(p.y)}
                r={10}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: "pointer" }}
              />
              <circle
                cx={xScale(p.x)}
                cy={yScale(p.y)}
                r={hovered === i ? 3.5 : 2}
                fill={SCORE_LINE_COLOR}
                stroke={hovered === i ? "#fff" : "none"}
                strokeWidth={0.5}
                pointerEvents="none"
              />
            </g>
          ))}
        </svg>
        {hovered !== null && (
          <ChartTooltip
            leftPct={(xScale(points[hovered].x) / width) * 100}
            topPct={(yScale(points[hovered].y) / height) * 100}
          >
            <div className="text-[10px] font-medium text-zinc-200">
              {fmtDateDay(points[hovered].label)}
            </div>
            <div className="flex items-center gap-1.5 text-[10px]">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: SCORE_LINE_COLOR }}
              />
              <span className="text-zinc-400">Score</span>
              <span className="text-zinc-100 tabular-nums">
                {points[hovered].y.toFixed(0)}
              </span>
            </div>
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

/** HRV trend — sleep-window HRV (solid) + daytime HRV (dashed) with
 * explicit Y-axis bounds so the numbers are legible. Latest values are
 * surfaced in the header. */
function HrvTrend({
  nights,
  daily,
}: {
  nights: NightEntry[];
  daily: DailyRollup[];
}) {
  const sleepPoints = nights
    .map((n) => ({ date: n.sleep_id, value: n.avg_hrv }))
    .filter((p) => p.value > 0);
  const daytimePoints = daily
    .map((d) => ({ date: d.date, value: d.daytime_rmssd_avg }))
    .filter((p): p is { date: string; value: number } => p.value != null);

  if (sleepPoints.length === 0 && daytimePoints.length === 0) {
    return (
      <p className="text-[10px] text-zinc-600">
        No HRV data in this window yet.
      </p>
    );
  }

  const width = 320;
  const height = 60;
  const pad = 4;
  const allY = [
    ...sleepPoints.map((p) => p.value),
    ...daytimePoints.map((p) => p.value),
  ];
  const yMinRaw = Math.min(...allY);
  const yMaxRaw = Math.max(...allY);
  // Add 10% headroom on each side so the lines don't graze the edges.
  const yPad = Math.max(1, (yMaxRaw - yMinRaw) * 0.1);
  const yMin = Math.max(0, yMinRaw - yPad);
  const yMax = yMaxRaw + yPad;
  const dateIdx = new Map(daily.map((d, i) => [d.date, i]));
  const xMax = Math.max(daily.length - 1, 1);
  const xScale = (i: number) => pad + (i / xMax) * (width - pad * 2);
  const yScale = (y: number) =>
    pad + (1 - (y - yMin) / Math.max(yMax - yMin, 1)) * (height - pad * 2);

  const sleepPath = sleepPoints
    .map((p) => ({ x: dateIdx.get(p.date), y: p.value }))
    .filter((p): p is { x: number; y: number } => p.x != null)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`)
    .join(" ");
  const daytimePath = daytimePoints
    .map((p) => ({ x: dateIdx.get(p.date), y: p.value }))
    .filter((p): p is { x: number; y: number } => p.x != null)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`)
    .join(" ");

  const latestSleep = sleepPoints[sleepPoints.length - 1];
  const latestDaytime = daytimePoints[daytimePoints.length - 1];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          HRV trend (ms)
        </span>
        <span className="flex items-center gap-3 text-[10px] text-zinc-500 tabular-nums">
          {latestSleep && (
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-px w-3"
                style={{ backgroundColor: SLEEP_HRV_COLOR }}
              />
              <span className="text-zinc-400">sleep</span>
              <span className="text-zinc-100">
                {Math.round(latestSleep.value)}
              </span>
            </span>
          )}
          {latestDaytime && (
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-px w-3"
                style={{
                  backgroundImage: `linear-gradient(to right, ${DAYTIME_HRV_COLOR} 50%, transparent 50%)`,
                  backgroundSize: "4px 1px",
                }}
              />
              <span className="text-zinc-400">day</span>
              <span className="text-zinc-100">
                {Math.round(latestDaytime.value)}
              </span>
            </span>
          )}
        </span>
      </div>
      <div className="flex items-stretch gap-2">
        <div className="flex flex-col justify-between py-0.5 text-[9px] text-zinc-600 tabular-nums select-none">
          <span>{Math.round(yMax)}</span>
          <span>{Math.round(yMin)}</span>
        </div>
        <div className="relative flex-1">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="w-full h-14"
          >
            {/* faint baseline + midline */}
            <line
              x1={pad}
              x2={width - pad}
              y1={yScale(yMin)}
              y2={yScale(yMin)}
              stroke="var(--color-zinc-800)"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={pad}
              x2={width - pad}
              y1={yScale((yMin + yMax) / 2)}
              y2={yScale((yMin + yMax) / 2)}
              stroke="var(--color-zinc-800)"
              strokeWidth={0.5}
              strokeDasharray="2,3"
              vectorEffect="non-scaling-stroke"
            />
            {sleepPath && (
              <path
                d={sleepPath}
                stroke={SLEEP_HRV_COLOR}
                strokeWidth={1.5}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {daytimePath && (
              <path
                d={daytimePath}
                stroke={DAYTIME_HRV_COLOR}
                strokeWidth={1.5}
                strokeDasharray="3,2"
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Daily activity + wear time chart with clearer labeling. */
function WearActivityRow({ daily }: { daily: DailyRollup[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const maxMinutes = 24 * 60;

  // Cumulative window totals give the user a sense of whether activity
  // is "low" in absolute terms vs just "low-looking on a 24h scale."
  const totals = daily.reduce(
    (acc, d) => {
      acc.sedentary += d.activity.sedentary_min;
      acc.light += d.activity.light_min;
      acc.moderate += d.activity.moderate_min;
      acc.vigorous += d.activity.vigorous_min;
      // Cap per-day wear at 24h. The backend's `wear_minutes_in_range`
      // sums the full duration of every wear period that intersects the
      // day (not the per-day overlap), so overlapping rows can push a
      // day's total past 24h. Clamp here so the summary doesn't show
      // nonsense like "1355h/day."
      acc.wear += Math.min(d.wear_minutes, maxMinutes);
      return acc;
    },
    { sedentary: 0, light: 0, moderate: 0, vigorous: 0, wear: 0 },
  );
  const activeWindowMin = totals.light + totals.moderate + totals.vigorous;
  const wearDays = daily.length;
  const avgWearHoursPerDay = wearDays > 0 ? totals.wear / 60 / wearDays : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Daily activity + wear time
        </span>
        <span className="text-[9px] text-zinc-600">
          bar = 24h · green = hours worn
        </span>
      </div>
      <div
        className="relative grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }}
      >
        {daily.map((d, i) => {
          const a = d.activity;
          const activeMin = a.light_min + a.moderate_min + a.vigorous_min;
          const wearPct = Math.min(
            100,
            Math.max(0, (d.wear_minutes / maxMinutes) * 100),
          );
          return (
            <div
              key={d.date}
              className="flex flex-col gap-[2px] cursor-pointer"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              aria-label={`activity breakdown for ${d.date}`}
            >
              <div className="h-10 w-full rounded-sm bg-zinc-900 overflow-hidden flex flex-col justify-end">
                {a.sedentary_min > 0 && (
                  <div
                    style={{
                      height: `${(a.sedentary_min / maxMinutes) * 100}%`,
                      backgroundColor: ACTIVITY_COLOR.sedentary,
                    }}
                  />
                )}
                {a.light_min > 0 && (
                  <div
                    style={{
                      height: `${(a.light_min / maxMinutes) * 100}%`,
                      backgroundColor: ACTIVITY_COLOR.light,
                    }}
                  />
                )}
                {a.moderate_min > 0 && (
                  <div
                    style={{
                      height: `${(a.moderate_min / maxMinutes) * 100}%`,
                      backgroundColor: ACTIVITY_COLOR.moderate,
                    }}
                  />
                )}
                {a.vigorous_min > 0 && (
                  <div
                    style={{
                      height: `${(a.vigorous_min / maxMinutes) * 100}%`,
                      backgroundColor: ACTIVITY_COLOR.vigorous,
                    }}
                  />
                )}
              </div>
              <div className="h-[3px] w-full rounded-sm bg-zinc-900 overflow-hidden">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${wearPct}%`,
                    backgroundColor: WEAR_COLOR,
                    opacity: 0.75,
                  }}
                />
              </div>
              <span className="block text-[9px] text-center text-zinc-600 tabular-nums">
                {fmtDateWeekday(d.date).slice(0, 1)}
              </span>
              {hovered === i && (
                <ChartTooltip
                  leftPct={((i + 0.5) / daily.length) * 100}
                  topPct={10}
                >
                  <div className="text-[10px] font-medium text-zinc-200">
                    {fmtDateDay(d.date)}
                  </div>
                  <div className="text-[10px] text-zinc-400">
                    wear {(Math.min(d.wear_minutes, maxMinutes) / 60).toFixed(1)}h
                    {" · "}active {Math.round(activeMin)}m
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5 text-[10px]">
                    <TooltipRow
                      color={ACTIVITY_COLOR.vigorous}
                      label="Vigorous"
                      value={`${Math.round(a.vigorous_min)}m`}
                    />
                    <TooltipRow
                      color={ACTIVITY_COLOR.moderate}
                      label="Moderate"
                      value={`${Math.round(a.moderate_min)}m`}
                    />
                    <TooltipRow
                      color={ACTIVITY_COLOR.light}
                      label="Light"
                      value={`${Math.round(a.light_min)}m`}
                    />
                    <TooltipRow
                      color={ACTIVITY_COLOR.sedentary}
                      label="Sedentary"
                      value={`${Math.round(a.sedentary_min)}m`}
                    />
                  </div>
                </ChartTooltip>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400">
        <LegendSwatch color={ACTIVITY_COLOR.vigorous} label="Vigorous" />
        <LegendSwatch color={ACTIVITY_COLOR.moderate} label="Moderate" />
        <LegendSwatch color={ACTIVITY_COLOR.light} label="Light" />
        <LegendSwatch color={ACTIVITY_COLOR.sedentary} label="Sedentary" />
        <LegendSwatch color={WEAR_COLOR} label="Wear time" />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500 tabular-nums">
        <span>
          Active (light+): {" "}
          <span className="text-zinc-200">{fmtMinutes(activeWindowMin)}</span>{" "}
          / {wearDays}d
        </span>
        <span>
          Vigorous:{" "}
          <span className="text-zinc-200">
            {fmtMinutes(totals.vigorous)}
          </span>
        </span>
        <span>
          Avg wear:{" "}
          <span className="text-zinc-200">
            {avgWearHoursPerDay.toFixed(1)}h
          </span>
          /day
        </span>
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-2 w-2 rounded-sm"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function TooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-zinc-400 flex-1">{label}</span>
      <span className="text-zinc-100 tabular-nums">{value}</span>
    </div>
  );
}

/** Generic chart tooltip: absolute-positioned by percent within its
 * relative-positioned parent. `topPct` is the Y position of the anchor;
 * the tooltip floats ABOVE that point with a 12px gap. Pointer events
 * disabled so it never steals a hover from the underlying chart. */
/** Generic chart tooltip.
 *
 * Rendered through a React portal onto the document body so no parent
 * `overflow-hidden` / `overflow-x-hidden` can clip it, and positioned
 * in fixed-viewport coordinates. On mount it measures itself with
 * `useLayoutEffect` and clamps to the viewport: centered above the
 * anchor by default, flipped below if there's no room above, and
 * nudged sideways if it would otherwise escape left or right. */
function ChartTooltip({
  leftPct,
  topPct,
  children,
}: {
  leftPct: number;
  topPct: number;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    opacity: 0,
  });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const parent = anchor?.parentElement;
    const tip = tipRef.current;
    if (!anchor || !parent || !tip) return;

    const pr = parent.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const ax = pr.left + (pr.width * leftPct) / 100;
    const ay = pr.top + (pr.height * topPct) / 100;

    const PAD = 8;
    const GAP = 8;

    // Default: centered above the anchor.
    let x = ax - tipRect.width / 2;
    let y = ay - tipRect.height - GAP;

    // Flip below if above doesn't fit.
    if (y < PAD) y = ay + GAP;

    // Clamp horizontally within the viewport.
    if (x < PAD) x = PAD;
    if (x + tipRect.width > window.innerWidth - PAD) {
      x = window.innerWidth - PAD - tipRect.width;
    }

    // Clamp vertically to the bottom edge as a last resort.
    if (y + tipRect.height > window.innerHeight - PAD) {
      y = window.innerHeight - PAD - tipRect.height;
    }

    setStyle({
      position: "fixed",
      left: x,
      top: y,
      opacity: 1,
    });
  }, [leftPct, topPct]);

  return (
    <>
      <span
        ref={anchorRef}
        aria-hidden
        style={{
          position: "absolute",
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: 0,
          height: 0,
        }}
      />
      {createPortal(
        <div
          ref={tipRef}
          className="z-50 rounded-md border border-zinc-700 bg-zinc-900/95 backdrop-blur px-2 py-1.5 shadow-lg pointer-events-none"
          style={{ minWidth: "120px", ...style }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Hypnogram thumbnail row (one per night), sorted by sleep_id ascending.
 *  Click a thumbnail to open the night in a zoom modal for closer inspection. */
function HypnogramRow({
  nights,
  onZoom,
}: {
  nights: NightEntry[];
  onZoom: (n: NightEntry) => void;
}) {
  if (nights.length === 0) {
    return (
      <p className="text-[10px] text-zinc-600">
        No sleep cycles in this window. Sync to pull the latest.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Hypnograms
        </span>
        <span className="text-[9px] text-zinc-600">
          tap to zoom · right column = sleep score
        </span>
      </div>
      <div className="flex items-center gap-2 px-1 text-[9px] uppercase tracking-wider text-zinc-600">
        <span className="w-14 shrink-0">Date</span>
        <span className="flex-1" aria-hidden />
        <span className="w-10 shrink-0 text-right">Score</span>
      </div>
      <div className="flex flex-col gap-[2px]">
        {nights.map((n) => (
          <div
            key={`${n.sleep_id}-${n.sleep_start}`}
            className="flex items-center gap-2"
          >
            <span className="w-14 shrink-0 text-[10px] text-zinc-500 tabular-nums">
              {fmtDateShort(nightOf(n.sleep_start))}
            </span>
            <div className="flex-1">
              <SkylineHypnogram
                hypnogram={n.hypnogram}
                heightClass="h-6"
                vbWidth={400}
                vbHeight={24}
                padding={{ l: 0, r: 0, t: 1, b: 1 }}
                depths={STAGE_DEPTH_THUMB}
                background="bg-zinc-800/40"
                transitionRadiusCap={4}
                onClick={() => onZoom(n)}
                ariaLabel={`Open hypnogram for ${nightOf(n.sleep_start)} in close-up view`}
              />
            </div>
            <span className="w-10 shrink-0 text-right text-[10px] text-zinc-400 tabular-nums">
              {n.performance_score != null
                ? Math.round(n.performance_score)
                : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stage composition stacked-bar row with custom hover tooltip. */
function StageCompositionRow({ nights }: { nights: NightEntry[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (nights.length === 0) return null;

  const maxTotal = Math.max(
    ...nights.map(
      (n) =>
        n.stages.awake_min + n.stages.light_min + n.stages.deep_min + n.stages.rem_min,
    ),
    1,
  );

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        Stage composition
      </span>
      <div
        className="relative grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${nights.length}, 1fr)` }}
      >
        {nights.map((n, i) => {
          const s = n.stages;
          return (
            <div
              key={`${n.sleep_id}-${n.sleep_start}`}
              className="flex h-12 flex-col justify-end overflow-hidden rounded-sm bg-zinc-900 cursor-pointer"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              {s.awake_min > 0 && (
                <div
                  style={{
                    height: `${(s.awake_min / maxTotal) * 100}%`,
                    backgroundColor: STAGE_COLOR.Wake,
                  }}
                />
              )}
              {s.light_min > 0 && (
                <div
                  style={{
                    height: `${(s.light_min / maxTotal) * 100}%`,
                    backgroundColor: STAGE_COLOR.Light,
                  }}
                />
              )}
              {s.rem_min > 0 && (
                <div
                  style={{
                    height: `${(s.rem_min / maxTotal) * 100}%`,
                    backgroundColor: STAGE_COLOR.REM,
                  }}
                />
              )}
              {s.deep_min > 0 && (
                <div
                  style={{
                    height: `${(s.deep_min / maxTotal) * 100}%`,
                    backgroundColor: STAGE_COLOR.Deep,
                  }}
                />
              )}
            </div>
          );
        })}
        {hovered !== null && (() => {
          const n = nights[hovered];
          const s = n.stages;
          const total = s.awake_min + s.light_min + s.deep_min + s.rem_min;
          return (
            <ChartTooltip
              leftPct={((hovered + 0.5) / nights.length) * 100}
              topPct={0}
            >
              <div className="text-[10px] font-medium text-zinc-200">
                {fmtDateDay(nightOf(n.sleep_start))}
              </div>
              <div className="text-[10px] text-zinc-400">
                total {fmtMinutes(total)}
              </div>
              <div className="mt-1 flex flex-col gap-0.5 text-[10px]">
                <TooltipRow
                  color={STAGE_COLOR.Deep}
                  label="Deep"
                  value={fmtMinutes(s.deep_min)}
                />
                <TooltipRow
                  color={STAGE_COLOR.REM}
                  label="REM"
                  value={fmtMinutes(s.rem_min)}
                />
                <TooltipRow
                  color={STAGE_COLOR.Light}
                  label="Light"
                  value={fmtMinutes(s.light_min)}
                />
                <TooltipRow
                  color={STAGE_COLOR.Wake}
                  label="Wake"
                  value={fmtMinutes(s.awake_min)}
                />
              </div>
            </ChartTooltip>
          );
        })()}
      </div>
      <div
        className="grid text-[9px] text-zinc-600 tabular-nums"
        style={{ gridTemplateColumns: `repeat(${nights.length}, 1fr)` }}
      >
        {nights.map((n) => (
          <span key={`${n.sleep_id}-${n.sleep_start}`} className="text-center">
            {fmtDateWeekday(nightOf(n.sleep_start)).slice(0, 1)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HistoryView({
  visible,
  mode = "compact",
}: {
  visible: boolean;
  /** "expanded" widens the section into two columns so daytime stats sit
   *  beside sleep stats; "compact" keeps the original single-column flow. */
  mode?: "compact" | "expanded";
}) {
  const [history, setHistory] = useState<SleepHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<NightEntry | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const h = await invoke<SleepHistory>("get_sleep_history", { days: 14 });
        if (!cancelled) {
          setHistory(h);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const sortedNights = useMemo(() => {
    if (!history) return [];
    return [...history.nights].sort((a, b) =>
      a.sleep_id.localeCompare(b.sleep_id),
    );
  }, [history]);

  if (error) {
    return (
      <section className="flex flex-col gap-3">
        <p className="text-xs text-rose-400">Failed to load history: {error}</p>
      </section>
    );
  }

  if (loading && !history) {
    return <HistorySkeleton />;
  }

  if (!history) return null;

  // In expanded mode, sleep stats sit on the left and daytime stats on
  // the right so the wider window doesn't waste horizontal space. Compact
  // keeps the original single-column flow that fits the tray.
  const isWide = mode === "expanded";
  const sleepBlock = (
    <div className="flex flex-col gap-5 min-w-0">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-zinc-200">
          Sleep — last 14 nights
        </h2>
        {!isWide && (
          <span className="text-[10px] text-zinc-500 tabular-nums">
            {fmtDateDay(history.range_start)} → {fmtDateDay(history.range_end)}
          </span>
        )}
      </div>
      <ScoreTrend nights={sortedNights} />
      <StageCompositionRow nights={sortedNights} />
      <HypnogramRow nights={sortedNights} onZoom={setZoomed} />
    </div>
  );
  const daytimeBlock = (
    <div className="flex flex-col gap-5 min-w-0">
      <div
        className={
          isWide
            ? "flex items-baseline justify-between"
            : "flex items-baseline justify-between border-t border-zinc-800/60 pt-3"
        }
      >
        <h2 className="text-sm font-medium text-zinc-200">
          Daytime — last 14 days
        </h2>
      </div>
      <HrvTrend nights={sortedNights} daily={history.daily} />
      <WearActivityRow daily={history.daily} />
    </div>
  );

  return (
    <section className="flex flex-col gap-5 pb-4 min-w-0 max-w-full">
      {isWide && (
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-zinc-200">Last 14 days</h2>
          <span className="text-[10px] text-zinc-500 tabular-nums">
            {fmtDateDay(history.range_start)} → {fmtDateDay(history.range_end)}
          </span>
        </div>
      )}
      {isWide ? (
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 auto-rows-min">
          {sleepBlock}
          {daytimeBlock}
        </div>
      ) : (
        <>
          {sleepBlock}
          {daytimeBlock}
        </>
      )}

      {zoomed && (
        <HypnogramModal
          title={fmtDateDay(nightOf(zoomed.sleep_start))}
          subtitle={`${new Date(zoomed.sleep_start).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })} → ${new Date(zoomed.sleep_end).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}${
            zoomed.performance_score != null
              ? ` · score ${Math.round(zoomed.performance_score)}`
              : ""
          }`}
          hypnogram={zoomed.hypnogram}
          cycleCount={null}
          onClose={() => setZoomed(null)}
        />
      )}
    </section>
  );
}
