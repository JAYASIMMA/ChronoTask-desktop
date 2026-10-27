# DJ Task Manager

A Windows desktop task and alarm manager built with **Rust + Tauri 2**, storing
everything in a local **SQLite** database. Alarms are scheduled by a native Rust
thread and delivered as branded Windows notifications, so they keep firing from the
system tray after the window is closed.

The UI is a hand-written HTML/CSS/JS front end with no framework and no build step.
Tauri embeds it into the binary at compile time, which means the shipped `.exe` is a
single self-contained file.

```
src-tauri/  Rust: SQLite layer, migration ladder, scheduler thread, notifications, tray
ui/         index.html · styles.css · app.js  (served from disk in dev, embedded in release)
tools/      build, install, verify and diagnostic scripts
```

## Download

Grab a ready-made build from the
[latest release](https://github.com/JAYASIMMA/ChronoTask-desktop/releases/latest):

| File | What it is |
| --- | --- |
| `DJ-Task-Manager_2.6.0_x64-setup.exe` | NSIS installer, ~3.6 MB. Recommended. |
| `dj-task-manager-2.6.0-x64-portable.exe` | The same app as one ~5 MB file, no installer. |
| `SHA256SUMS.txt` | Checksums for both. |

Builds are not code-signed, so SmartScreen warns on first run; verify the checksum
instead of overriding blindly. See [docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | install, verify, upgrade, uninstall |
| [docs/USAGE.md](docs/USAGE.md) | every view, alarm behaviour, the time picker, shortcuts |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | modules, schema, the `next_fire()` contract, trade-offs |
| [docs/BUILDING.md](docs/BUILDING.md) | prerequisites, dev loop, release build, versioning |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | toasts, alarms, database, build problems |
| [CHANGELOG.md](CHANGELOG.md) | what changed in each version |

## What it does

**Tasks** — priorities, tags, notes, due dates, subtasks with progress, filters,
recurring tasks (daily / weekdays / weekly by weekday mask) that roll themselves
forward into a fresh occurrence while archiving the completed one, and a full-text
search over title, notes and tags.

**Alarms** — one-off or repeating, with snooze, a snooze budget that eventually stops
nagging, escalating alarms that re-arm themselves, and advance warnings that fire a
chosen number of minutes before the due time of the linked task. Times are picked on
a clock dial, by keyboard (`07:15`, `7:15pm`, `19:15`), or with steppers.

**Missed alarms** — anything whose slot passed while the app was closed is caught up
on the next launch and logged with its source, so a laptop that slept through an alarm
is visibly different from one that was switched off.

**Calendar** — month grid with the day's alarms and due tasks, plus an alarm timeline.

**Settings & storage** — live database report (journal mode, page count, WAL size, row
counts per table, index list, migration history), integrity check, WAL checkpoint,
`VACUUM INTO` backup, CSV export, history pruning, JSON snapshot import/export, and a
workspace reset that clears content but keeps preferences.

## Architecture

```
 WebView (ui/)  ──invoke──▶  commands.rs (52 commands)
       ▲                          │
       └──── events ──────────────┤
                                  ▼
 scheduler.rs (1s tick thread) ─▶ db.rs ─▶ SQLite (WAL)
                                  │
                                  └─▶ notify.rs ─▶ Windows toast / tray
```

* **One writer, many readers.** The connection lives behind a `Mutex` and runs in WAL
  mode with a busy timeout, so the UI can read while the scheduler writes.
* **`next_fire()` is a Rust function registered into SQLite** (`rusqlite` custom
  scalar function). The list queries and the scheduler therefore compute the next
  occurrence with exactly one implementation, so the UI can never disagree with what
  will actually fire.
* **Migrations are a versioned ladder** stamped in `PRAGMA user_version` and mirrored
  into a `schema_history` table. Current schema version: **4**.
* **Recurrence is DST-safe.** Local dates are resolved through `chrono`'s
  `LocalResult`, mapping ambiguous times to the earlier occurrence and shifting
  nonexistent ones forward an hour.
* **The scheduler tracks its own drift** and re-syncs after sleep or hibernation
  instead of firing a burst of backlogged ticks.
* **Notifications** go through `tauri-winrt-notification` on Windows, which lets the
  app claim an `AppUserModelID`. Without that claim — and it cannot be claimed when the
  binary runs from `target\debug|release` — Windows shows an unbranded toast with no
  action buttons and no sound control.

## Requirements

| Need | Version |
| --- | --- |
| Rust | 1.77 or newer (`rust-version` in `src-tauri/Cargo.toml`) |
| MSVC build tools + Windows SDK | any recent |
| Node.js | current LTS (only for the Tauri CLI) |
| WebView2 runtime | present on Windows 10/11; the installer can embed the bootstrapper |

```bash
npm install          # installs @tauri-apps/cli
```

## Building

```bash
cd src-tauri
cargo test                      # 45 tests: 7 unit + 36 backend + 2 capability
cargo build --release           # target/release/dj-task-manager.exe  (~5 MB)
```

Or from the repository root, to also produce the installer:

```bash
npx tauri build                 # → src-tauri/target/release/bundle/nsis/DJ Task Manager_<version>_x64-setup.exe
```

The same as npm scripts, from the repository root: `npm run dev`, `npm run build`,
`npm test`.

> **Front-end changes need a rebuild.** Tauri embeds `ui/` at compile time.
> `src-tauri/build.rs` emits `rerun-if-changed` for those files precisely because
> without it a `ui/`-only edit could compile a binary that still contained the old
> interface. If you add subdirectories under `ui/`, extend that list.

### If NSIS bundling fails to download

The Tauri CLI fetches its own NSIS toolchain and the request occasionally times out
even when the URL is reachable. Seed the cache once and bundling works offline:

```powershell
powershell -ExecutionPolicy Bypass -File tools/fetch-nsis.ps1
```

## Installing

Full instructions, including checksums and uninstall, are in
[docs/INSTALL.md](docs/INSTALL.md). The short version:

```powershell
Start-Process ".\DJ-Task-Manager_2.6.0_x64-setup.exe" -ArgumentList '/S' -Wait
powershell -ExecutionPolicy Bypass -File tools/verify-install.ps1
```

Installation is per-user, so no administrator rights are needed. What a correct install
looks like:

* binary in `%LOCALAPPDATA%\DJ Task Manager\` (`tools/install.ps1` uses
  `%LOCALAPPDATA%\Programs\DJ Task Manager\` instead)
* Start Menu and desktop shortcuts
* one entry in *Add / Remove Programs*, pointing at a working uninstaller
* an app identity Windows can resolve — the NSIS shortcut carries the `AppUserModelID`
  itself, while `tools/install.ps1` writes
  `HKCU\Software\Classes\AppUserModelId\app.djtaskmanager.desktop`. Either is enough;
  both were verified with a live branded toast.
* a `HKCU\...\CurrentVersion\Run` entry launching `dj-task-manager.exe --minimized`,
  which **the app writes on first launch** from the stored preference, not the installer

## Running in the background

The scheduler is a thread inside the app process, so alarms fire whenever the app is
running — window open or not.

* Closing the window hides it to the tray by default and says so in a notification.
* **Launch at sign-in** registers the run key; the app then starts minimised.
* **Start hidden in the tray** opens with no window at all.
* Quitting from the tray menu genuinely stops scheduling.

## Data

Everything is local. Nothing leaves the machine; there is no network layer.

| Path | Contents |
| --- | --- |
| `%APPDATA%\app.djtaskmanager.desktop\djtaskmanager.db` | tasks, alarms, history, settings (+`-wal`, `-shm`) |
| `%LOCALAPPDATA%\DJ Task Manager\` | the installed binary; `tools/install.ps1` uses `...\Programs\DJ Task Manager\` |

A fresh database starts **empty** — no demo tasks or alarms — but with real default
preferences, so the toggles read back actual values.

```powershell
dj-task-manager.exe --reset-data    # clear every row, keep preferences, exit
```

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl` `K` | command palette |
| `Ctrl` `N` | new task |
| `Ctrl` `A` | schedule an alarm |
| `1` – `5` | Tasks · Alarms · Calendar · Missed · Settings |
| `J` / `K`, `X` | move through tasks, toggle complete |
| `↑` / `↓` (`Shift` for 15) | step minutes in the time field |
| `Esc` | close the topmost dialog |

## Tools

| Script | Purpose |
| --- | --- |
| `tools/fetch-nsis.ps1` | seed the NSIS toolchain so `tauri build` never downloads |
| `tools/install.ps1` · `tools/uninstall.ps1` | manual install and clean removal |
| `tools/verify-install.ps1` | assert binary, shortcuts, registry, AUMID and run key |
| `tools/capture-window.ps1` | PrintWindow capture of the app window |
| `tools/capture-screen.ps1` · `tools/crop-image.ps1` | full-desktop capture and crop, used to photograph toasts |
| `tools/click-in-window.ps1` | real pointer clicks and wheel scrolls at client coordinates |
| `tools/cdp-eval.js` | run JavaScript inside the live window over the DevTools protocol |
| `tools/probe-*.js` | end-to-end UI flows driven through `cdp-eval.js` |
| `tools/dump-db.js` | read the live SQLite file (`node tools/dump-db.js --sql "select …"`) |
| `tools/make-icon.js` | regenerate the app icon set |

The schema itself lives in `src-tauri/src/db/migrations.rs`, not in a separate `.sql`
file, so the migration ladder and the running database cannot drift apart. To see the
actual DDL of a live database:

```bash
node tools/dump-db.js --sql "select sql from sqlite_master where sql is not null"
```

To drive the UI with `tools/cdp-eval.js`, start the app with a debugging port:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
& "$env:LOCALAPPDATA\DJ Task Manager\dj-task-manager.exe"
node tools/cdp-eval.js "document.title"
```

## Testing

`cargo test` runs 45 tests against real SQLite files in scratch directories:
migration ladder, CRUD round-trips, the `next_fire()` contract, snooze budgets,
recurring snooze keeping its daily slot, missed-versus-fired accounting, FTS indexing
and injection handling, DST recurrence, backup, checkpoint and integrity, analytics
arithmetic, and the workspace reset. `src-tauri/tests/capabilities.rs` asserts the bundled SQLite
engine actually supports the features the queries rely on.

## Known limitations

* **Alarms need the app running.** It is a scheduled thread, not a Windows system
  alarm; nothing fires if you never sign in and the run key is off.
* **Single instance is not enforced.** Two copies mean two schedulers over one
  database; the WAL and busy timeout keep the data safe but an alarm can be delivered
  twice. Add `tauri-plugin-single-instance` if that matters for your setup.
* **Windows-focused.** The branded, audible, actionable toast path is Windows-only.
  Other platforms compile and fall back to the generic notification plugin.
* **Local time only.** Due dates and alarms are stored as epoch seconds resolved in the
  machine's zone; changing zones changes when things fire.
