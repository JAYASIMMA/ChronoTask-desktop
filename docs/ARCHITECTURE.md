# Architecture

## Shape

```
┌─────────────────────────┐        invoke        ┌──────────────────────────────┐
│  WebView (ui/app.js)    │ ───────────────────▶ │  commands.rs   52 commands   │
│  no framework, no build │ ◀─────── events ──── │  app://ready, app://notified │
└─────────────────────────┘                      └──────────────┬───────────────┘
                                                                │ Arc<Db>
                                                 ┌──────────────▼──────────────┐
      ┌────────────────                         │  db.rs  ── Mutex<Connection>│
      │ scheduler.rs   │  1s tick thread         │  ├─ db/migrations.rs        │
      │ notify.rs      │  delivers toasts        │  ├─ db/next_fire_fn.rs      │
      └────────────────                         │  ├─ db/recurrence.rs        │
                                                 │  ├─ db/history.rs           │
                                                 └──────────────┬──────────────┘
                                                                │ SQLite (WAL)
```

Rust owns persistence, scheduling and native integration. The front end owns rendering
and nothing else — it never touches the filesystem or the network.

## Modules

| File | Responsibility |
| --- | --- |
| `src-tauri/src/lib.rs` | plugin setup, tray, window-close behaviour, CLI flags, command registration |
| `src-tauri/src/commands.rs` | the IPC surface: 52 `#[tauri::command]` functions, thin by design |
| `src-tauri/src/db.rs` | connection, pragmas, row mapping, CRUD |
| `src-tauri/src/db/migrations.rs` | the versioned schema ladder |
| `src-tauri/src/db/next_fire_fn.rs` | the `next_fire()` SQL function and its occurrence maths |
| `src-tauri/src/db/recurrence.rs` | rolling recurring tasks forward, DST-safe resolution |
| `src-tauri/src/db/history.rs` | alarm history and activity audit writes |
| `src-tauri/src/db/analytics.rs` | search, analytics, CSV, backup, integrity, reset |
| `src-tauri/src/scheduler.rs` | the tick loop and the two pure evaluation functions |
| `src-tauri/src/notify.rs` | Windows app identity and toast delivery |
| `src-tauri/src/state.rs` | shared app state: the `Db`, start time, tick counter, drift |

## Persistence

One SQLite file, opened with:

```
journal_mode = WAL          synchronous = NORMAL
foreign_keys = ON           busy_timeout = 5000
```

WAL is what lets the UI read while the scheduler writes; the busy timeout stops a
concurrent reader from turning a scheduler write into an error. The connection sits
behind a `Mutex`, so there is exactly one writer and no `Send` gymnastics. Every query
layer method takes `&self` and locks internally.

`rusqlite` is built with the `bundled` feature, so the SQLite engine is compiled into
the binary. Nothing is loaded at runtime, which is why the portable `.exe` works on a
machine with no database installed.

### The migration ladder

`PRAGMA user_version` is the source of truth; `schema_history` is a human-readable
mirror of it. Each step is a `(version, name, apply)` triple and pending steps run in
order inside their own transaction. `add_column` is guarded by `pragma_table_info`, so
a step is safe to re-apply to a database that already has the column.

```
1  baseline                       tasks, subtasks, alarms, missed_alarms, settings, meta
2  alarm-policy-and-recurrence    recurrence, advance_min, snooze budget, escalate, parent_id
3  history-and-fts                alarm_history, activity_log, tasks_fts + triggers
4  snooze-window                  alarms.snoozed_until
```

Tests open a scratch database through `open_scratch()`, which runs the ladder without
seeding content or performing startup catch-up — that separation is what makes the
migration tests deterministic.

## One rule for "when does it fire"

`next_fire(fire_at, repeat, days_json, last_fired_at, snoozed_until)` is a Rust function
registered into the SQLite connection as a scalar function. The list queries call it from
SQL; the scheduler calls the same Rust function directly.

That is deliberate. When the rule lived in both places, the alarm list could show a time
the scheduler would never fire, and recurring alarms silently never fired at all. The
contract:

* the anchor is `last_fired_at`, falling back to `fire_at - 1` so the first slot is never
  skipped
* a snooze is applied as `max(occurrence, snoozed_until)` — a snoozed daily alarm wakes at
  the snooze moment but keeps its daily slot
* `NULL` days means the weekday mask is unused; `days` is JSON parsed with `json_each`

Because it is registered per-connection, `EXPLAIN` output and ad-hoc queries in
`tools/dump-db.js` use the identical function.

## Scheduler semantics

The loop ticks once per second against `Instant`, and each tick:

1. measures how late it ran and records the drift
2. if the lateness exceeds 2 seconds — sleep, hibernation, or a starved thread — it
   resets the schedule to one second from now rather than replaying every missed tick
3. runs `evaluate_due()` and `evaluate_preflight()`
4. delivers the resulting events

`evaluate_due(db, now, started_at, grace)` is pure with respect to the app: given a
database and a timestamp it returns the events it produced, already persisted. That is
what makes the timing behaviour testable without waiting for time to pass.

Late classification: `late = now - due`; `late > GRACE_SECONDS` (90) is **missed**,
otherwise **fired**. A missed alarm is recorded once, as missed — never as both missed
and fired — and its source is `offline` when the slot passed before this process
started, `runtime` otherwise. One-off alarms dismiss themselves after firing; escalating
ones re-arm through the snooze path.

Advance warnings are tracked per due date via `last_preflight_for`, so a task that stays
overdue cannot spam the same warning.

## Notifications

Windows will not brand a toast unless the process has claimed an `AppUserModelID` that
the shell can resolve to a real app. Two things follow from that:

* `notify::init_identity()` calls `SetCurrentProcessExplicitAppUserModelID` at startup,
  through a direct `shell32` declaration rather than a dependency on the `windows` crate
* the claim is useless unless the shell knows the app — the NSIS installer stamps the
  AUMID onto the Start Menu shortcut, and `tools/install.ps1` writes
  `HKCU\Software\Classes\AppUserModelId\<id>` with a display name and icon instead.
  Either mechanism is sufficient; both were verified with a live toast

The app detects a development run (binary under `target\debug` or `target\release`) and
reports it in Settings, because in that state Windows shows an anonymous toast.

Delivery goes through `tauri-winrt-notification`, which gives control the web notification
API cannot: `Scenario::Alarm` with a looping sound for sticky alarms, `Duration::Long`
otherwise, explicit sound names that must match the OS's casing, and action buttons that
route back into the app. If that path errors, delivery falls back to
`tauri-plugin-notification` so an alarm is never lost to a rendering problem, and every
delivery also emits `app://notified` so the in-app banner stays in step.

## Recurrence and time zones

All timestamps are epoch seconds. Local wall-clock intent is preserved by resolving
dates through `chrono`'s `LocalResult`:

* `Single` — normal case
* `Ambiguous` (fall-back hour) — the earlier occurrence wins
* `None` (spring-forward gap) — shifted an hour forward rather than dropped

Rolling a recurring task forward writes an archived copy carrying its subtasks' state,
resets live subtasks to undone, and moves `due_at` to the next occurrence. The archived
copy is what the calendar and the completion analytics read, so "tasks completed today"
keeps counting occurrences rather than templates.

## Search

`tasks_fts` is an FTS5 table with `content='tasks'` — an external-content index, so no
second copy of the text is stored — kept in sync by `AFTER INSERT/UPDATE/DELETE`
triggers, using the `delete` command rather than `remove` so rowids stay aligned.
Queries run through `bm25` with a `snippet()` on the title column, and user input is
neutralised before it reaches MATCH: FTS operators are stripped so a stray `AND`, `"`,
or `*` cannot turn a search into a syntax error or an injection. A LIKE pass supplements
results for partial words that the tokenizer would otherwise miss.

## Front end

`ui/app.js` is one classic script — no modules, no bundler, no framework — with a state
object `S`, a `render()` that rebuilds the active view, and a single delegated click
router. Icons are Unicode glyphs from a lookup table, so the UI renders identically with
no network access and no icon font.

Two things are load-bearing and easy to break by accident:

* **`taskPayload(task, overrides)`** builds a complete `TaskInput` for every partial
  save. Rust treats an omitted field as the serde default, so a save that only sends the
  title would silently clear recurrence, tags or the parent link.
* **dialog layers** — `openModal` appends a layer rather than replacing the host's
  contents, so the picker can open over the task editor. A dialog with a later sibling
  ignores its own save, because `Enter` and scripted clicks reach buttons that a pointer
  cannot.

`src-tauri/build.rs` emits `rerun-if-changed` for every file in `ui/`. Without it, cargo
sees no Rust change, skips recompiling the crate, and `tauri::generate_context!` never
re-reads the front end — the build succeeds and ships the old interface.

## Trade-offs worth knowing

* **A mutex over a connection pool.** The scheduler writes once a second at most and the
  UI reads on interaction. A pool would add complexity to buy nothing.
* **Re-render the whole view on change.** The dataset is a personal task list, not a
  thousand rows; diffing would cost more than it saves.
* **Epoch seconds in the database.** Sorting and comparison are trivial, and the local
  wall-clock intent is reconstructible because recurrence is resolved through
  `LocalResult` rather than stored as a naive string.
* **No single-instance guard.** Two processes mean two schedulers over one database.
  WAL and the busy timeout keep the data intact, but an alarm can be delivered twice.
  `tauri-plugin-single-instance` is the one-line fix if that matters.
