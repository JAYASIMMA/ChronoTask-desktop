# Troubleshooting

Start with the two built-in readouts: the **status bar** shows scheduler liveness and
tick drift, and **Settings → Storage Engine** shows the real database path, journal
mode and row counts. Most mysteries resolve there.

## Toasts are unbranded or silent

Windows decides how to present a toast from the app identity it can resolve, so the
causes are always about identity or about OS-level suppression.

1. **Running from a build directory.** A binary under `target\debug` or `target\release`
   cannot be branded — that is a Windows rule, not an app setting. The app detects it and
   *Settings → Background & Startup* says "Running unpackaged". Install it, or run
   `tools/install.ps1` to register the identity around a portable copy.
2. **No identity registered.** An NSIS install stamps the AppUserModelID onto the Start
   Menu shortcut; `tools/install.ps1` writes
   `HKCU\Software\Classes\AppUserModelId\app.djtaskmanager.desktop` instead. Either is
   enough. Check with `tools/verify-install.ps1`.
3. **Windows is suppressing them.** **Windows Settings → System → Notifications** - is the app in
   the list and enabled? Is **Do not disturb** or a focus session active? Notification
   permissions are per-app and survive reinstalls.
4. **Sound is off at the OS level.** A toast with a sound still respects the system
   volume mixer, which lists the app separately once it has made a sound.
5. **`native_toasts` is off.** The first toggle under *Notifications & scheduling*
   controls OS delivery; with it off you only get the in-app banner.

Use *Settings → Notifications & Scheduling → Test* to exercise the real delivery path, then look at the
toast that appears: branded with the app name and icon means identity is correct.

## An alarm did not fire

Work through these in order:

* **Is the app running?** Alarms are scheduled by a thread inside the process. Nothing
  fires from a machine where the app never started — check the tray.
* **What state is the alarm in?** Only `armed` alarms fire. A one-off alarm becomes
  `dismissed` after it fires once; deleting its task sets it to `paused`.
* **Is it in the missed list instead?** An alarm more than 90 seconds past its slot is
  recorded as missed, with source `offline` if the slot passed before this process
  started. It is still delivered — it just is not counted as on time.
* **Is it linked to a task whose advance warning you expected?** Advance warnings fire
  relative to the *task's* due time, once per due date, and only when `advance_min` is
  non-zero.

The scheduler's tick drift is in the status bar. A few hundred milliseconds is normal; a
large number means the machine slept or the thread was starved, and the loop
deliberately re-syncs rather than replaying every missed tick.

## The same alarm fired twice

Two copies of the app are running — the portable build and the installed one, say. Each
has its own scheduler reading the same database. Quit both from the tray, then start one.
There is no single-instance guard yet; see
[ARCHITECTURE](ARCHITECTURE.md#trade-offs-worth-knowing).

## A leftover alarm after deleting a task

Deleting a task **disarms and detaches** its reminder rather than deleting it, so the
alarm survives as `paused` with no task. That is intentional — nothing you created is
destroyed silently. Delete it from *Alarms & Timers* if you do not want it. Each such
disarm is recorded in the history as `paused — task removed`:

```bash
node tools/dump-db.js --sql "select label, event, note, datetime(at,'unixepoch','localtime') from alarm_history order by id desc limit 20"
```

## Front-end changes do not appear in the build

`tauri::generate_context!` embeds `ui/` at compile time. If cargo does not recompile the
crate, the old interface ships and the build still reports success.
`src-tauri/build.rs` emits `rerun-if-changed` for every file in `ui/` to prevent exactly
this. If you add subdirectories under `ui/`, extend that list. To confirm what is really
inside a running build:

```bash
node tools/cdp-eval.js "(async()=>{const t=await (await fetch('/app.js')).text(); return t.length})()" --async
```

Compare against `wc -c ui/app.js`; the difference is the multibyte characters counted as
one code unit each.

## Bundling fails with `timeout: global`

The Tauri CLI's own download of the NSIS toolchain. `curl` the same URL and it works —
the CLI's HTTP client is at fault. Run `tools/fetch-nsis.ps1` once, then bundle again.

## SmartScreen blocks the installer

Expected: the binaries are not code-signed. Verify integrity instead of overriding
blindly — compare `Get-FileHash .\setup.exe -Algorithm SHA256` against `SHA256SUMS.txt`
from the release.

## A `tools/*.ps1` script fails to parse

If the error is "The string is missing the terminator" on a line that looks fine, the
file contains a non-ASCII character. PowerShell 5.1 reads UTF-8 without a BOM as ANSI and
an em dash's third byte *is* a double quote. Keep these scripts ASCII-only.

## The database looks wrong

Non-destructive first:

* Settings → Database Health & Analytics → Integrity runs `PRAGMA integrity_check`
* *Checkpoint* flushes the WAL into the main file — worth doing if `-wal` looks large
* *Backup .db* writes a consistent copy with `VACUUM INTO` and refuses to overwrite

To inspect directly (the app can stay running; WAL allows concurrent readers):

```bash
node tools/dump-db.js
node tools/dump-db.js --sql "select * from alarms"
```

To start clean while keeping preferences, run the app with `--reset-data`, or use
Settings → About → Clear workspace. To restore, use *Import* with a JSON snapshot.

## Where things live

| Path | Contents |
| --- | --- |
| `%APPDATA%\app.djtaskmanager.desktop\djtaskmanager.db` | the database, plus `-wal` and `-shm` |
| `%LOCALAPPDATA%\DJ Task Manager\` | installed by `setup.exe` (with `uninstall.exe`) |
| `%LOCALAPPDATA%\Programs\DJ Task Manager\` | installed by `tools/install.ps1` |

Older builds used the identifier `app.chronotask.desktop`; its folder in `%APPDATA%` is
unused now and can be deleted once you are sure you do not need anything from it.

## Driving the app for diagnosis

Attach a debugging port and script the live UI:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
& "$env:LOCALAPPDATA\DJ Task Manager\dj-task-manager.exe"
```

```bash
node tools/cdp-eval.js "S.view"                                   # read state
node tools/cdp-eval.js "window.__TAURI__.core.invoke('stats')" --async   # call the backend
node tools/cdp-eval.js @tools/probe-picker.js --async             # replay a full UI flow
```
