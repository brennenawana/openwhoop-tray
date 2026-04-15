# openwhoop-tray

A clean, minimal desktop companion for [openwhoop](https://github.com/bWanShiTong/openwhoop) — built with Tauri 2, React 19, and Tailwind 4. Links directly against the openwhoop Rust crates via a git submodule at `vendor/openwhoop`.

## Status

Phase 1a (in progress):

- [x] Tauri 2 scaffold (macOS, Windows, Linux)
- [x] Rust backend linking `openwhoop-db`, `openwhoop-algos`, `openwhoop-codec`, `openwhoop-entities`, `openwhoop-types` as library path deps from the submodule
- [x] `get_snapshot` command — reads heart-rate, sleep cycles, and activities from the SQLite database and returns a rich dashboard payload
- [x] Dark-mode-first React UI with:
  - Current HR, min/avg/max
  - Latest stress, SpO₂, skin temp
  - 24h hourly-HR bar sparkline
  - Latest sleep card (duration, score, HR range, HRV range)
  - Last-7-days summary (nights, avg sleep, consistency, workouts)
- [x] App-data-dir SQLite path (`~/Library/Application Support/dev.brennen.openwhoop-tray/db.sqlite` on macOS)
- [ ] `sync_now` command wired to real BLE + algo pipeline *(stub for now)*
- [ ] Menu bar tray icon with live current-HR
- [ ] Window hidden by default; click tray to toggle
- [ ] First-run onboarding (device discovery + pick)
- [ ] Configurable sync cadence
- [ ] Launch at login

## Getting started

```sh
# First clone
git clone --recursive <this-repo-url>
cd openwhoop-tray
pnpm install

# Run in dev
pnpm tauri dev
```

If you already cloned without `--recursive`:
```sh
git submodule update --init --recursive
```

## Architecture

```
openwhoop-tray/
├── src/                      # React frontend (TypeScript)
│   ├── App.tsx               # Main dashboard view
│   ├── types.ts              # Type mirror of Rust Snapshot struct
│   └── App.css               # Tailwind import + dark theme vars
├── src-tauri/                # Rust backend
│   ├── Cargo.toml            # Depends on openwhoop crates via path
│   └── src/lib.rs            # Tauri commands + snapshot assembly
└── vendor/
    └── openwhoop/            # git submodule -> brennenawana/openwhoop
                              # (integration/whoop-tray branch)
```

The Rust side is the sole owner of the database and BLE connection. The React side is pure presentation — it invokes Tauri commands and renders the result.

## DB location

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/dev.brennen.openwhoop-tray/db.sqlite` |
| Linux | `~/.local/share/dev.brennen.openwhoop-tray/db.sqlite` |
| Windows | `%APPDATA%\dev.brennen.openwhoop-tray\db.sqlite` |

For now, if you want to point at an existing `db.sqlite` you've been building with the CLI, copy it into the app data dir before first launch.
