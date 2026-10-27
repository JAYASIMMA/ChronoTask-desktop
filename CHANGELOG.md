# Changelog

All notable changes to DJ Task Manager are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [2.6.0] — 2026-10-27

First published release, with an installer and a portable binary.

### Added

- **Clock dial** in the date/time picker — point or drag to set the hour, then it
  switches to minutes. Hour mode shows 12 marks, minute mode shows all 60.
- **Typed time entry** accepting `07:15`, `7:15`, `7:15pm`, `19:15`, `6.45`, with
  `↑`/`↓` stepping a minute and `Shift`+`↑`/`↓` stepping fifteen. Unparseable input is
  flagged and ignored rather than overwriting the current time.
- **Stacked dialogs.** The task editor can open the picker on top of itself, so an
  unfinished draft survives the detour. `Esc` closes only the topmost dialog.
- `tools/fetch-nsis.ps1` to seed the NSIS toolchain when the Tauri CLI's own download
  times out, and `tools/verify-install.ps1` to assert a complete installation.
- A `deleted` alarm-history event, so removing an alarm is distinguishable from
  disabling it.

### Changed

- **"Attach alarm" now asks for a time.** It previously set the alarm to the next top
  of hour with no way to choose, which is why attaching an alarm felt impossible.
- **Branded Windows notifications.** Alerts go through `tauri-winrt-notification` with
  a claimed `AppUserModelID`, so toasts carry the app name and icon, use a real sound
  profile, and expose *Open DJ Task Manager* / *Dismiss* actions once installed.
- **Sign-in launch** is now reconciled with the stored preference in both directions,
  and the Settings switch reflects the preference instead of the registry probe, which
  reported "not registered" for an entry that was present.
- **Deleting a task disarms and detaches its reminder** rather than leaving an alarm
  firing for a task that no longer exists. The alarm row is kept, not destroyed.
- Demo workspace removed: a fresh database starts empty with real default preferences.

### Fixed

- `src-tauri/build.rs` now watches `ui/`. Before this, an edit that only touched the
  front end could compile a binary still containing the old interface.
- The alarm-history cascade read the wrong column index and swallowed the error, so
  attached alarms were silently skipped.

## [2.5.0] — 2026-10-27

Development milestone, never published as a binary.

- Renamed from ChronoTask to **DJ Task Manager**, with a new identifier
  (`app.djtaskmanager.desktop`), icon, tray id and installer metadata.
- Native notification path, tray operation, close-to-tray, `--minimized` start, and
  sign-in launch.
- Scheduler re-syncs the tick clock after sleep or hibernation instead of releasing a
  backlog of missed ticks in one burst.

## [2.4.1] — 2026-10-26

- SQLite backend expanded to a real persistence layer: versioned migration ladder
  (`PRAGMA user_version`, mirrored into `schema_history`), `next_fire()` registered as
  a Rust function inside SQLite so SQL listings and the scheduler share one rule,
  recurrence with DST-safe resolution, FTS5 search with trigger-maintained index,
  alarm history and activity audit tables, analytics, backup via `VACUUM INTO`,
  integrity check, WAL checkpoint and CSV export.
- Scheduler split into testable `evaluate_due` / `evaluate_preflight`.
- Missed alarms are logged once, as missed, so reliability figures stopped
  double-counting.

## [2.0.0] — 2026-10-26

- Initial Tauri 2 desktop application reproducing the five screens of the
  *Desktop Task & Alarm Manager* design: tasks, alarms, calendar, missed alarms and
  settings, over a single-file release binary.

[2.6.0]: https://github.com/JAYASIMMA/ChronoTask-desktop/releases/tag/v2.6.0
