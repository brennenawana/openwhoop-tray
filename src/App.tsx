import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AlarmStatus, DiscoveredDevice, Snapshot } from "./types";
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

function BatteryPill({
  percent,
  charging,
}: {
  percent: number;
  charging: boolean;
}) {
  const color =
    charging
      ? "bg-sky-400"
      : percent > 50
      ? "bg-emerald-400"
      : percent > 20
      ? "bg-amber-400"
      : "bg-rose-400";
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2 py-0.5 text-[9px] font-normal text-zinc-400 tabular-nums">
      <span className={`w-1 h-1 rounded-full ${color}`} />
      {percent.toFixed(1)}%
      {charging && <span className="text-sky-400">⚡</span>}
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
  const [syncInterval, setSyncInterval] = useState<number>(0);
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
