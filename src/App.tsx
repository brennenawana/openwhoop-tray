import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "./types";
import "./App.css";

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

function Sparkline({ values }: { values: (number | null)[] }) {
  const filled = values.filter((v): v is number => v !== null);
  if (filled.length === 0) {
    return <div className="text-zinc-600 text-xs">No data yet.</div>;
  }
  const min = Math.min(...filled);
  const max = Math.max(...filled);
  const span = Math.max(1, max - min);
  const currentHour = new Date().getHours();
  return (
    <div className="flex items-end gap-[2px] h-10 w-full">
      {values.map((v, i) => {
        const isActive = i === currentHour;
        const height =
          v === null ? 4 : 6 + Math.round(((v - min) / span) * 28);
        return (
          <div
            key={i}
            className={`flex-1 rounded-sm transition-all ${
              v === null
                ? "bg-zinc-800"
                : isActive
                ? "bg-rose-400"
                : "bg-zinc-500"
            }`}
            style={{ height }}
            title={v === null ? `${i}:00 — no data` : `${i}:00 — ${v} bpm`}
          />
        );
      })}
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

type TempUnit = "C" | "F";

function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => {
    return (localStorage.getItem("tempUnit") as TempUnit) || "C";
  });
  const toggleTemp = () => {
    const next: TempUnit = tempUnit === "C" ? "F" : "C";
    setTempUnit(next);
    localStorage.setItem("tempUnit", next);
  };

  const refresh = useCallback(async () => {
    try {
      const snap = await invoke<Snapshot>("get_snapshot");
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSync = async () => {
    setSyncing(true);
    try {
      await invoke("sync_now");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const t = snapshot?.today;
  const s = snapshot?.latest_sleep;
  const w = snapshot?.week;

  return (
    <main className="flex flex-col h-screen px-6 py-5 gap-6 text-zinc-100">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">OpenWhoop</h1>
          <p className="text-xs text-zinc-500">
            {snapshot
              ? `Last refresh ${formatClock(snapshot.generated_at)}`
              : "Loading…"}
          </p>
        </div>
        <button
          onClick={onSync}
          disabled={syncing}
          className="rounded-md bg-rose-500/90 hover:bg-rose-500 active:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium transition-colors"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </header>

      {error && (
        <div className="rounded-md border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

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
              <Sparkline values={t.hourly_bpm} />
              <div className="flex justify-between text-[9px] text-zinc-600 tabular-nums pt-1">
                <span>0</span>
                <span>6</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
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
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">{s.night}</span>
              <span className="text-xs text-zinc-500 tabular-nums">
                {formatTime(s.start)} → {formatTime(s.end)}
              </span>
            </div>
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
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            No sleep cycles detected yet.
          </p>
        )}
      </Section>

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
