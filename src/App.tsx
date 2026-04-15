import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot } from "./types";
import "./App.css";

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

type SyncReport = {
  duration_secs: number;
  new_readings: number;
  total_readings: number;
  sleep_nights: number;
  activities: number;
};

type BackendConfig = {
  device_name: string | null;
};

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStage, setSyncStage] = useState<SyncStage | null>(null);
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => {
    return (localStorage.getItem("tempUnit") as TempUnit) || "C";
  });
  const [deviceName, setDeviceName] = useState<string>("");
  const [showSettings, setShowSettings] = useState<boolean>(false);

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

  const refresh = useCallback(async () => {
    try {
      const snap = await invoke<Snapshot>("get_snapshot");
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Initial hydration: load config from backend, then snapshot.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<BackendConfig>("get_config");
        const name = cfg.device_name ?? "";
        setDeviceName(name);
        if (!name) setShowSettings(true);
      } catch (e) {
        setError(String(e));
      }
      refresh();
    })();
  }, [refresh]);

  // Subscribe to sync lifecycle events from the backend (including tray-initiated syncs).
  useEffect(() => {
    const unlistenFns: (() => void)[] = [];
    (async () => {
      unlistenFns.push(
        await listen<SyncStage>("sync:progress", (e) => {
          setSyncStage(e.payload);
          setSyncing(e.payload !== "done");
        })
      );
      unlistenFns.push(
        await listen<SyncReport>("sync:complete", (e) => {
          setLastSync(e.payload);
          setSyncing(false);
          setSyncStage(null);
          refresh();
        })
      );
      unlistenFns.push(
        await listen<string>("sync:error", (e) => {
          setError(e.payload);
          setSyncing(false);
          setSyncStage(null);
        })
      );
    })();
    return () => unlistenFns.forEach((fn) => fn());
  }, [refresh]);

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
          <h1 className="text-lg font-semibold tracking-tight">OpenWhoop</h1>
          <p className="text-xs text-zinc-500">
            {syncing && syncStage
              ? STAGE_LABEL[syncStage]
              : syncing
              ? "Syncing with strap…"
              : snapshot
              ? `Last refresh ${formatClock(snapshot.generated_at)}`
              : "Loading…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-md border border-zinc-800 hover:border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Settings"
          >
            ⚙
          </button>
          <button
            onClick={onSync}
            disabled={syncing}
            className="rounded-md bg-rose-500/90 hover:bg-rose-500 active:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium transition-colors"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">
            Device name
          </label>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => saveDeviceName(e.target.value)}
            placeholder="WHOOP 4C0968309"
            className="rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
          <p className="text-[10px] text-zinc-600">
            The name your strap broadcasts over Bluetooth. Run{" "}
            <code className="text-zinc-400">openwhoop scan</code> in a terminal
            to find it.
          </p>
        </div>
      )}

      {lastSync && !syncing && (
        <div className="rounded-md border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
          Synced in {lastSync.duration_secs.toFixed(1)}s · +
          {lastSync.new_readings} new readings · {lastSync.total_readings}{" "}
          total · {lastSync.sleep_nights} sleep nights ·{" "}
          {lastSync.activities} activities
        </div>
      )}

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
