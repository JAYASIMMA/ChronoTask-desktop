# Using DJ Task Manager

Five views, reached from the sidebar or the number keys. Everything is local; there is
no account, no sync and no network traffic.

## Tasks

The task list is the default view. Each row shows priority, due time, subtask progress
and, when one is attached, the alarm pill.

| Keys | Action |
| --- | --- |
| `Ctrl` `N` | new task |
| `1` | jump to Tasks |
| `J` / `K` or `↑` / `↓` | move the selection |
| `X` | toggle complete |
| `Ctrl` `K` | command palette — jump anywhere, run any action |

A task carries a title, notes, priority (`P1` urgent to `P4` trivial), status (Todo,
In Progress, Done), tags, a due date, and a repeat rule. Subtasks are added inline and
count towards the row's progress bar.

The filter tabs — All, Today, High Priority, Completed — are backed by SQL, as is the
search box, which runs a `bm25`-ranked FTS5 query over title, notes and tags and falls
back to substring matching for partial words.

### Repeating tasks

Setting a repeat rule on a task turns it into a template. When you complete it, the
completed occurrence is archived with its subtask state intact and a fresh occurrence
is rolled forward to the next due date, with subtasks reset to undone. Weekly repeats
pick weekdays on a Monday-first mask.

Repetition is computed in the machine's local time and is daylight-saving safe: an
ambiguous time resolves to the earlier occurrence, a nonexistent one shifts forward an
hour. If the app was closed for several periods, it catches up to the next upcoming one
rather than firing every missed period.

## Alarms

`Ctrl` `A` opens the scheduler. An alarm has a label, a time, a repeat rule, a snooze
length, a sound, and optionally a linked task.

**Choosing the time** works three ways, and all three stay in sync:

* point at the **clock dial** — it sets the hour, then flips to minutes; drag to sweep
* **type** into the time field: `07:15`, `7:15`, `7:15pm`, `19:15`, `6.45`. `↑`/`↓`
  steps a minute, `Shift`+`↑`/`↓` steps fifteen, `Enter` confirms
* the **hour/minute steppers** and the quick-set chips

**Sounds** map onto real Windows toast sounds: Chime plays the reminder tone, Subtle
Bell plays the IM tone, Synthetic Pulse plays the mail tone. An escalating alarm always
uses the looping alarm tone, because that is the one Windows will keep playing.

**States** are `armed`, `paused` and `dismissed`. A one-off alarm dismisses itself after
firing; a repeating one stays armed and moves to its next slot.

**Snooze** behaves differently by kind, which is what makes it predictable:

* a one-off alarm moves its own `fire_at` — it is a single event being pushed back
* a repeating alarm keeps its slot and opens a temporary snooze window, so snoozing
  your 07:00 alarm by ten minutes does not shift the alarm forever

**Snooze budget** caps how many times an alarm may be snoozed; when the budget runs out
the alarm dismisses itself and records why. **Escalate** makes a one-off re-arm itself
on its snooze interval until you acknowledge it, rather than waiting for you to snooze.

**Advance warning** is separate from the alarm time: it fires a given number of minutes
before the *linked task's* due time, once per due date.

## Calendar

Month grid with the day's alarms and due tasks, and an alarm timeline for the selected
day. Recurring templates are hidden from the grid; their materialised occurrences show
instead, so a daily task appears once per day rather than as one forever-entry.

## Missed alarms

Anything whose slot passed without being delivered lands here, tagged with its source:

* `runtime` — the app was open and the slot passed while it was running
* `offline` — the slot passed before the current process started

An alarm that is more than 90 seconds late is recorded as missed, not fired, and it is
recorded once. That single rule is what makes the reliability figures in Settings
trustworthy. From here you can snooze the whole set in one action or resolve entries
individually.

## Settings

* **Notifications & scheduling** — native toasts on/off, catch-up on launch, default
  snooze, and a *Send a test toast* button that exercises the real delivery path.
* **Appearance** — dark or light theme, compact rows.
* **Storage Engine** and **Schema & Row Counts** — database path, page count, WAL size, journal mode, row counts
  per table, applied migrations and indexes.
* **Database health** — `integrity_check`, WAL checkpoint, `VACUUM INTO` backup, CSV
  export of tasks or alarms, history pruning, and a workspace reset that clears content
  but keeps preferences.
* **Background & startup** — launch at sign-in and start-hidden, plus a line telling
  you whether this is an installed build (branded toasts) or a development run.

## Running in the background

Alarms are scheduled by a thread inside the app process. Closing the window hides it to
the tray and a notification tells you so; **Launch at sign-in** starts it minimised at
every sign-in; **Start hidden in the tray** opens with no window at all. Quitting from
the tray menu genuinely stops scheduling.

The scheduler tracks its own tick drift and shows it in the status bar. If the machine
sleeps or hibernates, it re-syncs on wake instead of releasing every backlogged tick at
once.
