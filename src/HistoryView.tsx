import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DailyRollup,
  HypnogramEntry,
  NightEntry,
  SleepHistory,
  SleepStage,
} from "./types";

// Matches App.tsx STAGE_COLOR exactly so the thumbnail hypnograms in the
// History view read the same as the Latest Sleep strip on the Now view.
const STAGE_COLOR: Record<SleepStage, string> = {
  Wake: "#71717a",
  Light: "#60a5fa",
  Deep: "#1e3a8a",
  REM: "#f472b6",
  Unknown: "#3f3f46",
};

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

/** One night's hypnogram rendered as a narrow thumbnail column. */
function HypnogramThumb({ hypnogram }: { hypnogram: HypnogramEntry[] }) {
  if (hypnogram.length === 0) {
    return <div className="h-10 w-full rounded-sm bg-zinc-900" />;
  }
  const t0 = new Date(hypnogram[0].start).getTime();
  const t1 = new Date(hypnogram[hypnogram.length - 1].end).getTime();
  const total = Math.max(t1 - t0, 1);
  return (
    <div className="flex h-10 w-full overflow-hidden rounded-sm bg-zinc-900">
      {hypnogram.map((h, i) => {
        const start = new Date(h.start).getTime();
        const end = new Date(h.end).getTime();
        const width = ((end - start) / total) * 100;
        return (
          <div
            key={i}
            style={{
              width: `${width}%`,
              backgroundColor: STAGE_COLOR[h.stage as SleepStage] ?? "#4b5563",
            }}
            title={`${h.stage} · ${new Date(h.start).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}`}
          />
        );
      })}
    </div>
  );
}

/** Score trend — inline SVG line chart, one point per night. */
function ScoreTrend({ nights }: { nights: NightEntry[] }) {
  const points = nights
    .map((n, i) => ({
      x: i,
      y: n.performance_score ?? null,
      label: n.sleep_id,
    }))
    .filter((p): p is { x: number; y: number; label: string } => p.y != null);

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
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Score trend
        </span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          avg {avg.toFixed(0)}
        </span>
      </div>
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
          stroke="#3f3f46"
          strokeDasharray="2,2"
        />
        <path d={path} stroke="#fb7185" strokeWidth={1.5} fill="none" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xScale(p.x)}
            cy={yScale(p.y)}
            r={2}
            fill="#fb7185"
          >
            <title>
              {fmtDateDay(p.label)} · {p.y.toFixed(0)}
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/** HRV line: sleep-window avg HRV (solid) + daytime daytime_rmssd_avg (dashed). */
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
  // Combined Y range across both series for comparable axes.
  const allY = [
    ...sleepPoints.map((p) => p.value),
    ...daytimePoints.map((p) => p.value),
  ];
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);
  // X-axis is day index within `daily`. sleep points key off their date.
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          HRV trend
        </span>
        <span className="flex items-center gap-2 text-[9px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-px w-3 bg-indigo-400" />
            sleep
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-px w-3 bg-teal-300"
              style={{
                backgroundImage:
                  "linear-gradient(to right, #5eead4 50%, transparent 50%)",
                backgroundSize: "4px 1px",
              }}
            />
            daytime
          </span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-14"
      >
        {sleepPath && (
          <path d={sleepPath} stroke="#818cf8" strokeWidth={1.5} fill="none" />
        )}
        {daytimePath && (
          <path
            d={daytimePath}
            stroke="#5eead4"
            strokeWidth={1.5}
            strokeDasharray="3,2"
            fill="none"
          />
        )}
      </svg>
    </div>
  );
}

/** Per-day wear + activity stacked-bar row. One bar per calendar day. */
function WearActivityRow({ daily }: { daily: DailyRollup[] }) {
  const maxMinutes = 24 * 60;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Wear + activity
        </span>
        <span className="text-[9px] text-zinc-600">
          sedentary · light · moderate · vigorous
        </span>
      </div>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }}>
        {daily.map((d) => {
          const a = d.activity;
          const total =
            a.sedentary_min + a.light_min + a.moderate_min + a.vigorous_min;
          return (
            <div
              key={d.date}
              className="flex flex-col gap-[2px]"
              title={`${fmtDateDay(d.date)} · wear ${(d.wear_minutes / 60).toFixed(
                1,
              )}h · activity ${total.toFixed(0)}m`}
            >
              <div
                className="h-8 w-full rounded-sm bg-zinc-900 overflow-hidden flex flex-col justify-end"
                aria-label={`activity breakdown for ${d.date}`}
              >
                {/* Stack bottom-up so vigorous sits at top. */}
                {a.sedentary_min > 0 && (
                  <div
                    style={{
                      height: `${(a.sedentary_min / maxMinutes) * 100}%`,
                      backgroundColor: "#475569",
                    }}
                  />
                )}
                {a.light_min > 0 && (
                  <div
                    style={{
                      height: `${(a.light_min / maxMinutes) * 100}%`,
                      backgroundColor: "#22d3ee",
                    }}
                  />
                )}
                {a.moderate_min > 0 && (
                  <div
                    style={{
                      height: `${(a.moderate_min / maxMinutes) * 100}%`,
                      backgroundColor: "#fbbf24",
                    }}
                  />
                )}
                {a.vigorous_min > 0 && (
                  <div
                    style={{
                      height: `${(a.vigorous_min / maxMinutes) * 100}%`,
                      backgroundColor: "#f472b6",
                    }}
                  />
                )}
              </div>
              <div className="h-[3px] w-full rounded-sm bg-zinc-900">
                <div
                  className="h-full rounded-sm bg-emerald-500/70"
                  style={{ width: `${(d.wear_minutes / maxMinutes) * 100}%` }}
                  aria-label={`wear minutes for ${d.date}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div
        className="grid text-[9px] text-zinc-600 tabular-nums"
        style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }}
      >
        {daily.map((d) => (
          <span key={d.date} className="text-center">
            {fmtDateWeekday(d.date).slice(0, 1)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Hypnogram thumbnail row (one per night), sorted by sleep_id ascending. */
function HypnogramRow({ nights }: { nights: NightEntry[] }) {
  if (nights.length === 0) {
    return (
      <p className="text-[10px] text-zinc-600">
        No sleep cycles in this window. Sync to pull the latest.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        Hypnograms
      </span>
      <div className="flex flex-col gap-[2px]">
        {nights.map((n) => (
          <div
            key={`${n.sleep_id}-${n.sleep_start}`}
            className="flex items-center gap-2"
          >
            <span className="w-14 shrink-0 text-[10px] text-zinc-500 tabular-nums">
              {fmtDateShort(n.sleep_id)}
            </span>
            <div className="flex-1">
              <HypnogramThumb hypnogram={n.hypnogram} />
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

/** Stage composition stacked-bar row: one bar per night, stacked by stage minutes. */
function StageCompositionRow({ nights }: { nights: NightEntry[] }) {
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
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${nights.length}, 1fr)` }}
      >
        {nights.map((n) => {
          const s = n.stages;
          return (
            <div
              key={`${n.sleep_id}-${n.sleep_start}`}
              className="flex h-12 flex-col justify-end overflow-hidden rounded-sm bg-zinc-900"
              title={`${fmtDateDay(n.sleep_id)} · light ${s.light_min.toFixed(
                0,
              )}m · deep ${s.deep_min.toFixed(0)}m · rem ${s.rem_min.toFixed(
                0,
              )}m · awake ${s.awake_min.toFixed(0)}m`}
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
      </div>
      <div
        className="grid text-[9px] text-zinc-600 tabular-nums"
        style={{ gridTemplateColumns: `repeat(${nights.length}, 1fr)` }}
      >
        {nights.map((n) => (
          <span key={`${n.sleep_id}-${n.sleep_start}`} className="text-center">
            {fmtDateWeekday(n.sleep_id).slice(0, 1)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HistoryView({ visible }: { visible: boolean }) {
  const [history, setHistory] = useState<SleepHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    return (
      <section className="flex flex-col gap-3">
        <p className="text-xs text-zinc-500">Loading last 14 nights…</p>
      </section>
    );
  }

  if (!history) return null;

  return (
    <section className="flex flex-col gap-5 pb-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-zinc-200">
          Last 14 nights
        </h2>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {fmtDateDay(history.range_start)} → {fmtDateDay(history.range_end)}
        </span>
      </div>

      <ScoreTrend nights={sortedNights} />
      <StageCompositionRow nights={sortedNights} />
      <HypnogramRow nights={sortedNights} />
      <HrvTrend nights={sortedNights} daily={history.daily} />
      <WearActivityRow daily={history.daily} />
    </section>
  );
}
