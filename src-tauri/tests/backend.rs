//! Backend integration tests: every case runs against a real SQLite file in a scratch
//! directory, exercising migrations, the query layer, the scheduler's decision logic,
//! and the maintenance commands.
use dj_task_manager_lib::db::migrations::TARGET_VERSION;
use dj_task_manager_lib::db::next_fire_fn;
use dj_task_manager_lib::db::{AlarmInput, Db, TaskInput};
use dj_task_manager_lib::scheduler;
use chrono::{Datelike, Local, TimeZone};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MIN: i64 = 60;
const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;

fn at(y: i32, mo: u32, d: u32, hh: u32, mi: u32) -> i64 {
    Local
        .with_ymd_and_hms(y, mo, d, hh, mi, 0)
        .single()
        .expect("fixed test dates must be valid local times")
        .timestamp()
}

/// Midday today, local. Using a fixed midday slot keeps "due today" assertions from
/// flipping over when the suite happens to run around midnight.
fn noon_today() -> i64 {
    let now = Local::now();
    at(now.year(), now.month(), now.day(), 12, 0)
}

fn scratch_dir(name: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("djtm-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn cleanup(dir: PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

struct Scratch {
    dir: PathBuf,
    db: Arc<Db>,
}

impl Scratch {
    fn new(name: &str) -> Scratch {
        let mut dir = std::env::temp_dir();
        dir.push(format!("djtm-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        let db = Db::open_scratch(&dir, "scratch.db").expect("open scratch db");
        Scratch { dir, db: Arc::new(db) }
    }
    fn path(&self) -> &Path {
        &self.dir
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Best effort: a locked file just leaves a temp dir behind.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn task(db: &Db, title: &str, due: Option<i64>) -> dj_task_manager_lib::db::Task {
    db.save_task(&TaskInput {
        title: title.into(),
        due_at: due,
        ..Default::default()
    })
    .expect("save_task")
}

fn alarm(db: &Db, label: &str, fire_at: i64, repeat: &str) -> dj_task_manager_lib::db::Alarm {
    db.save_alarm(&AlarmInput {
        label: label.into(),
        fire_at,
        repeat: repeat.into(),
        ..Default::default()
    })
    .expect("save_alarm")
}

// -- schema ----------------------------------------------------------------

#[test]
fn migrations_reach_target_version() {
    let s = Scratch::new("migrate");
    let report = s.db.schema_report().unwrap();
    assert_eq!(report["userVersion"], TARGET_VERSION, "schema not at target");
    assert_eq!(report["upToDate"], true);
    assert_eq!(report["fts5"], true, "FTS5 index must exist");
    assert_eq!(report["applied"].as_array().unwrap().len(), TARGET_VERSION as usize);
}

#[test]
fn reopening_an_existing_database_keeps_data_and_applies_nothing() {
    let s = Scratch::new("reopen");
    task(&s.db, "persisted task", Some(chrono::Local::now().timestamp()));
    s.db.set_setting("theme", "light").unwrap();

    // A second handle over the same file is what a restart looks like under WAL.
    let reopened = Db::open_scratch(s.path(), "scratch.db").expect("reopen");
    let report = reopened.schema_report().unwrap();
    assert_eq!(report["applied"].as_array().unwrap().len(), TARGET_VERSION as usize, "must not re-run");
    assert_eq!(reopened.list_tasks("", "").unwrap().len(), 1);
    assert_eq!(reopened.get_setting("theme").as_deref(), Some("light"));
    // The original handle still sees the write, proving the second open changed nothing.
    assert_eq!(s.db.list_tasks("", "").unwrap().len(), 1);
}

#[test]
fn connection_is_configured_for_wal_and_busy_timeout() {
    let s = Scratch::new("pragmas");
    let c = s.db.conn.lock().unwrap();
    let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode.to_lowercase(), "wal", "WAL keeps reads from blocking the scheduler");
    let timeout: i64 = c.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
    assert!(timeout >= 5_000, "busy_timeout should be several seconds, got {timeout}");
    let fk: i64 = c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(fk, 1, "foreign keys must be enforced for cascade deletes");
}

// -- tasks -----------------------------------------------------------------

#[test]
fn task_crud_roundtrip_and_input_validation() {
    let s = Scratch::new("crud");
    let created = s
        .db
        .save_task(&TaskInput {
            title: "  Wire tray menu  ".into(),
            notes: "tooltip text".into(),
            priority: "bogus".into(),
            status: "doing".into(),
            due_at: Some(chrono::Local::now().timestamp()),
            tags: vec!["core".into(), "UI".into()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(created.title, "Wire tray menu", "title must be trimmed");
    assert_eq!(created.priority, "p3", "unknown priority must fall back");
    assert_eq!(created.status, "doing");
    assert_eq!(created.tags, vec!["core", "UI"]);
    assert_eq!(created.recurrence, "none");

    let updated = s
        .db
        .save_task(&TaskInput {
            id: Some(created.id),
            title: "Wire tray menu v2".into(),
            notes: created.notes.clone(),
            priority: "p1".into(),
            status: created.status.clone(),
            due_at: created.due_at,
            tags: created.tags.clone(),
            recurrence: created.recurrence.clone(),
            recur_days: created.recur_days.clone(),
            parent_id: created.parent_id,
        })
        .unwrap();
    assert_eq!(updated.title, "Wire tray menu v2");
    assert_eq!(updated.priority, "p1");
    assert_eq!(updated.notes, "tooltip text");

    assert!(s.db.save_task(&TaskInput::default()).is_err(), "empty title must be rejected");
    assert!(s
        .db
        .save_task(&TaskInput {
            title: "recurring without date".into(),
            recurrence: "daily".into(),
            ..Default::default()
        })
        .is_err());

    s.db.delete_task(created.id).unwrap();
    assert!(s.db.task_by_id(created.id).is_err());
}

#[test]
fn filters_and_search_scope_the_task_list() {
    let s = Scratch::new("filters");
    let now = chrono::Local::now().timestamp();
    task(&s.db, "due today", Some(noon_today()));
    task(&s.db, "overdue one", Some(now - DAY));
    task(&s.db, "tomorrow task", Some(now + DAY));
    let done = task(&s.db, "finished thing", Some(now - DAY));
    s.db.set_task_status(done.id, "done").unwrap();

    assert_eq!(s.db.list_tasks("", "").unwrap().len(), 4);
    assert_eq!(s.db.list_tasks("today", "").unwrap().len(), 1);
    assert_eq!(s.db.list_tasks("overdue", "").unwrap().len(), 1, "completed overdue must not count");
    assert_eq!(s.db.list_tasks("completed", "").unwrap().len(), 1);
    assert_eq!(s.db.list_tasks("open", "").unwrap().len(), 3);
    assert_eq!(s.db.list_tasks("", "tomorrow").unwrap().len(), 1);
    assert_eq!(s.db.list_tasks("", "zzzz").unwrap().len(), 0);
}

#[test]
fn status_changes_are_audited() {
    let s = Scratch::new("audit");
    let t = task(&s.db, "audited", None);
    s.db.set_task_status(t.id, "doing").unwrap();
    s.db.add_subtask(t.id, "step one").unwrap();
    let kinds: Vec<String> = s
        .db
        .list_activity(Some(t.id), 20)
        .unwrap()
        .into_iter()
        .map(|a| a.kind)
        .collect();
    assert!(kinds.contains(&"created".to_string()), "creation must be logged: {kinds:?}");
    assert!(kinds.contains(&"status".to_string()), "status change must be logged: {kinds:?}");
}

// -- full text search ------------------------------------------------------

#[test]
fn fts_search_covers_title_notes_and_tags() {
    let s = Scratch::new("fts");
    s.db
        .save_task(&TaskInput {
            title: "Finalize SQLite IPC contextBridge handlers".into(),
            notes: "Guard queries with payload validation schemas".into(),
            tags: vec!["backend".into()],
            ..Default::default()
        })
        .unwrap();
    task(&s.db, "unrelated grocery list", None);

    let by_title = s.db.search_tasks("sqlite", 10).unwrap();
    assert_eq!(by_title.len(), 1, "title term must match exactly one task");
    assert_eq!(by_title[0].engine, "fts5");
    assert!(by_title[0].snippet.contains("<b>"), "snippet should mark the match");

    assert_eq!(s.db.search_tasks("validation", 10).unwrap().len(), 1, "notes are indexed");
    assert_eq!(s.db.search_tasks("backend", 10).unwrap().len(), 1, "tags are indexed");
    assert_eq!(s.db.search_tasks("grocery", 10).unwrap().len(), 1);
}

#[test]
fn fts_index_stays_in_sync_with_updates_and_deletes() {
    let s = Scratch::new("fts-sync");
    let t = s
        .db
        .save_task(&TaskInput {
            title: "Zephyr turbine calibration".into(),
            notes: "torque spec".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s.db.search_tasks("zephyr", 10).unwrap().len(), 1);

    s.db
        .save_task(&TaskInput {
            id: Some(t.id),
            title: "Gearbox calibration".into(),
            notes: "torque spec".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s.db.search_tasks("zephyr", 10).unwrap().len(), 0, "stale index entry survived an update");
    assert_eq!(s.db.search_tasks("gearbox", 10).unwrap().len(), 1);

    s.db.delete_task(t.id).unwrap();
    assert_eq!(s.db.search_tasks("gearbox", 10).unwrap().len(), 0, "deleted row left an index entry");
}

#[test]
fn fts_query_injection_is_neutralised() {
    let s = Scratch::new("fts-inject");
    task(&s.db, "plain task", None);
    // These would be FTS5 syntax errors or boolean operators if passed through raw.
    for hostile in ["NEAR(a b)", "\"quoted\"", "a AND", "NOT title", "*", "-", "a OR", "}{"] {
        let res = s.db.search_tasks(hostile, 10);
        assert!(res.is_ok(), "query {hostile:?} must not error: {:?}", res.err());
    }
}

// -- recurrence ------------------------------------------------------------

#[test]
fn completing_a_recurring_task_archives_a_snapshot_and_rolls_forward() {
    let s = Scratch::new("recur");
    let now = chrono::Local::now().timestamp();
    let t = s
        .db
        .save_task(&TaskInput {
            title: "Weekly review".into(),
            notes: "agenda".into(),
            due_at: Some(now - HOUR),
            recurrence: "daily".into(),
            ..Default::default()
        })
        .unwrap();
    let subs = s.db.add_subtask(t.id, "collect metrics").unwrap();
    s.db.toggle_subtask(subs[0].id).unwrap();

    let rolled = s.db.set_task_status(t.id, "done").unwrap();
    assert_eq!(rolled.status, "todo", "the schedule must reopen for the next period");
    assert!(rolled.due_at.unwrap() > now, "next due {:?} should be after now {now}", rolled.due_at);
    assert_eq!(rolled.recurrence, "daily", "the template keeps its rule");
    assert_eq!(rolled.archived, false);

    let snapshots = s.db.list_occurrences(10).unwrap();
    assert_eq!(snapshots.len(), 1, "exactly one archived occurrence");
    assert_eq!(snapshots[0].status, "done");
    assert_eq!(snapshots[0].subtask_done, 1, "the snapshot keeps the finished checklist");
    assert!(snapshots[0].completed_at.is_some());

    let live = s.db.list_subtasks(t.id).unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].done, false, "the new period starts with a reset checklist");

    // Archived snapshots must not clutter the normal list.
    assert_eq!(s.db.list_tasks("", "").unwrap().len(), 1);
    assert_eq!(s.db.list_tasks("occurrences", "").unwrap().len(), 1);
}

#[test]
fn catch_up_recurring_skips_missed_periods() {
    let s = Scratch::new("recur-catchup");
    let now = chrono::Local::now().timestamp();
    let t = s
        .db
        .save_task(&TaskInput {
            title: "Standup notes".into(),
            due_at: Some(now - 3 * DAY),
            recurrence: "weekdays".into(),
            ..Default::default()
        })
        .unwrap();
    let moved = s.db.catch_up_recurring().unwrap();
    assert_eq!(moved, 1);
    let after = s.db.task_by_id(t.id).unwrap();
    assert!(after.due_at.unwrap() > now, "stale schedule must move into the future");
    assert_eq!(after.status, "todo");
    assert_eq!(s.db.catch_up_recurring().unwrap(), 0, "second pass must be a no-op");
}

// -- alarms and the scheduler ---------------------------------------------

#[test]
fn recurring_alarm_fires_once_per_period() {
    // Regression: anchoring the next-fire search on "now" instead of "last fired"
    // made the due slot always land in the future, so recurring alarms never fired.
    let s = Scratch::new("alarm-daily");
    let now = chrono::Local::now().timestamp();
    let a = alarm(&s.db, "Standup sync", now - MIN, "daily");
    assert!(a.next_fire_at.unwrap() <= now, "a daily alarm whose slot passed must read as due");

    let events = scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(events.len(), 1, "first tick fires the alarm");
    assert_eq!(events[0].kind, "fired", "one minute late is inside the grace window");

    let again = scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    assert!(again.is_empty(), "the same period must not fire twice");

    let kept = s.db.alarm_by_id(a.id).unwrap();
    assert_eq!(kept.state, "armed", "a recurring alarm stays armed after firing");
    assert!(kept.next_fire_at.unwrap() > now, "and rolls to the next period");
}

#[test]
fn late_alarm_is_logged_as_missed_with_the_right_source() {
    let s = Scratch::new("alarm-missed");
    let now = chrono::Local::now().timestamp();
    alarm(&s.db, "Offline alarm", now - 2 * HOUR, "none");

    // Started after the slot passed => the alarm was missed while the app was closed.
    let events = scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "missed");
    assert_eq!(events[0].source, "offline");
    assert!(events[0].logged_id.is_some(), "a missed alarm must reference its catch-up row");

    let open = s.db.list_missed(true).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].resolution, "unhandled");
    assert_eq!(s.db.stats().unwrap().missed_unhandled, 1);

    s.db.resolve_missed(open[0].id, "acknowledged").unwrap();
    assert_eq!(s.db.list_missed(true).unwrap().len(), 0);
    assert_eq!(s.db.list_missed(false).unwrap().len(), 1, "resolved rows stay in the log");
}

#[test]
fn alarm_missed_while_running_is_attributed_to_runtime() {
    let s = Scratch::new("alarm-runtime");
    let now = chrono::Local::now().timestamp();
    alarm(&s.db, "Ran while open", now - 2 * HOUR, "none");
    // App started before the slot => the tick simply lagged: runtime, not offline.
    let events = scheduler::evaluate_due(&s.db, now, now - 4 * HOUR, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(events[0].source, "runtime");
}

#[test]
fn one_off_alarm_dismisses_after_firing() {
    let s = Scratch::new("alarm-oneoff");
    let now = chrono::Local::now().timestamp();
    let a = alarm(&s.db, "Code freeze", now - 30, "none");
    let events = scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(s.db.alarm_by_id(a.id).unwrap().state, "dismissed");
    assert!(s.db.armed_alarms().unwrap().is_empty());
}

#[test]
fn escalating_alarm_re_arms_itself() {
    let s = Scratch::new("alarm-escalate");
    let now = chrono::Local::now().timestamp();
    let a = s
        .db
        .save_alarm(&AlarmInput {
            label: "Wake up".into(),
            fire_at: now - 10,
            snooze_min: 5,
            escalate: true,
            ..Default::default()
        })
        .unwrap();
    scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    let after = s.db.alarm_by_id(a.id).unwrap();
    assert_eq!(after.state, "armed", "escalating alarms nag instead of dismissing");
    assert!(after.fire_at > now);
    assert_eq!(after.snooze_count, 1);
}

#[test]
fn snooze_budget_eventually_disables_the_alarm() {
    let s = Scratch::new("alarm-snooze");
    let now = chrono::Local::now().timestamp();
    let a = s
        .db
        .save_alarm(&AlarmInput {
            label: "Snooze limited".into(),
            fire_at: now - HOUR,
            snooze_min: 5,
            max_snoozes: 2,
            ..Default::default()
        })
        .unwrap();

    let first = s.db.snooze_alarm(a.id, 5).unwrap();
    assert_eq!(first.state, "armed");
    assert_eq!(first.snooze_count, 1);
    let second = s.db.snooze_alarm(a.id, 5).unwrap();
    assert_eq!(second.snooze_count, 2);

    let third = s.db.snooze_alarm(a.id, 5).unwrap();
    assert_eq!(third.state, "dismissed", "the budget must eventually stop the nagging");
    let events = s.db.list_alarm_history(Some(a.id), 20).unwrap();
    assert!(
        events.iter().any(|e| e.event == "disabled"),
        "disabling must be recorded, got {:?}",
        events.iter().map(|e| &e.event).collect::<Vec<_>>()
    );
}

#[test]
fn advance_warning_fires_once_per_due_date() {
    let s = Scratch::new("alarm-preflight");
    let now = chrono::Local::now().timestamp();
    let t = task(&s.db, "Ship release", Some(now + 30 * MIN));
    let a = s
        .db
        .save_alarm(&AlarmInput {
            label: "Release prep".into(),
            fire_at: now + DAY,
            task_id: Some(t.id),
            advance_min: 20,
            ..Default::default()
        })
        .unwrap();

    let warn_at = now + 10 * MIN; // 20 minutes before the due time
    let events = scheduler::evaluate_preflight(&s.db, warn_at).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "preflight");
    assert_eq!(events[0].task_title.as_deref(), Some("Ship release"));

    assert!(scheduler::evaluate_preflight(&s.db, warn_at + MIN).unwrap().is_empty(), "must not repeat");
    assert_eq!(s.db.alarm_by_id(a.id).unwrap().last_preflight_for, Some(t.due_at.unwrap()));

    // Moving the due date re-arms the warning for the new slot.
    s.db
        .save_task(&TaskInput { id: Some(t.id), title: "Ship release".into(), due_at: Some(now + 5 * HOUR), ..Default::default() })
        .unwrap();
    assert_eq!(scheduler::evaluate_preflight(&s.db, now + 4 * HOUR + 45 * MIN).unwrap().len(), 1);
}

#[test]
fn alarm_history_records_the_lifecycle() {
    let s = Scratch::new("alarm-history");
    let now = chrono::Local::now().timestamp();
    let a = alarm(&s.db, "Trail", now - 5, "none");
    scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    s.db.snooze_alarm(a.id, 10).unwrap();
    s.db.delete_alarm(a.id).unwrap();
    let events: Vec<String> = s
        .db
        .list_alarm_history(None, 50)
        .unwrap()
        .into_iter()
        .map(|e| e.event)
        .collect();
    for expected in ["armed", "fired", "snoozed", "deleted"] {
        assert!(events.contains(&expected.to_string()), "missing {expected} in {events:?}");
    }
}

#[test]
fn next_fire_rules_are_anchored_on_last_fired() {
    let monday = at(2026, 10, 26, 9, 45);
    assert_eq!(Local.timestamp_opt(monday, 0).single().unwrap().weekday().to_string(), "Mon");

    // One-off: the slot itself, even in the past.
    assert_eq!(next_fire_fn::compute_value(monday, "none", &[], None, None), Some(monday));
    // Daily, never fired: its own slot.
    assert_eq!(next_fire_fn::compute_value(monday, "daily", &[], None, None), Some(monday));
    // Daily, already fired: tomorrow.
    assert_eq!(next_fire_fn::compute_value(monday, "daily", &[], Some(monday), None), Some(monday + DAY));
    // Weekdays from Friday: skips the weekend to Monday.
    let friday = at(2026, 10, 30, 9, 45);
    assert_eq!(
        next_fire_fn::compute_value(friday, "weekdays", &[], Some(friday), None),
        Some(friday + 3 * DAY)
    );
    // Weekly with a Thursday mask from a Monday.
    let thursday = at(2026, 10, 29, 9, 45);
    assert_eq!(next_fire_fn::compute_value(monday, "weekly", &[3], None, None), Some(thursday));
    // Unknown repeat falls back to the raw slot rather than dropping the alarm.
    assert_eq!(next_fire_fn::compute_value(monday, "monthly", &[], None, None), Some(monday));
    // A pending snooze wins when it is later than the schedule...
    assert_eq!(
        next_fire_fn::compute_value(monday, "daily", &[], None, Some(monday + 2 * HOUR)),
        Some(monday + 2 * HOUR)
    );
    // ...but never pulls an already-later slot backwards.
    assert_eq!(
        next_fire_fn::compute_value(monday, "daily", &[], Some(monday), Some(monday - HOUR)),
        Some(monday + DAY)
    );
}

#[test]
fn catch_up_snooze_all_handles_the_whole_queue() {
    let s = Scratch::new("catchup");
    let now = chrono::Local::now().timestamp();
    let a = alarm(&s.db, "Queue one", now - 2 * HOUR, "none");
    let b = alarm(&s.db, "Queue two", now - 3 * HOUR, "none");
    scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(s.db.list_missed(true).unwrap().len(), 2);

    for row in s.db.list_missed(true).unwrap() {
        s.db.resolve_missed(row.id, "snoozed").unwrap();
        if let Some(id) = row.alarm_id {
            s.db.snooze_alarm(id, 10).unwrap();
        }
    }
    assert!(s.db.list_missed(true).unwrap().is_empty());
    for id in [a.id, b.id] {
        let rearmed = s.db.alarm_by_id(id).unwrap();
        assert_eq!(rearmed.state, "armed");
        assert!(rearmed.fire_at > now);
    }
}

// -- analytics, export, maintenance ---------------------------------------

#[test]
fn analytics_computes_on_time_rate_and_completions() {
    let s = Scratch::new("analytics");
    let now = chrono::Local::now().timestamp();
    // A full day either side of the completion instant, so no clock reading can flip
    // the on-time/late classification.
    let on_time = task(&s.db, "on time", Some(now + DAY));
    let late = task(&s.db, "late one", Some(now - DAY));
    s.db.set_task_status(on_time.id, "done").unwrap();
    s.db.set_task_status(late.id, "done").unwrap();

    let a = s.db.analytics(14).unwrap();
    assert_eq!(a["onTime"]["total"], 2);
    assert_eq!(a["onTime"]["onTime"], 1);
    assert_eq!(a["onTime"]["rate"], 50.0);
    assert!(!a["completions"].as_array().unwrap().is_empty(), "today's bucket must exist");
    assert_eq!(a["windowDays"], 14);
}

#[test]
fn analytics_counts_alarm_events_by_kind() {
    let s = Scratch::new("analytics-alarms");
    let now = chrono::Local::now().timestamp();
    alarm(&s.db, "reliability one", now - 10, "none");
    alarm(&s.db, "reliability two", now - 4 * HOUR, "none");
    scheduler::evaluate_due(&s.db, now, now, scheduler::GRACE_SECONDS).unwrap();
    let a = s.db.analytics(7).unwrap();
    assert_eq!(a["alarmEvents"]["fired"], 1);
    assert_eq!(a["alarmEvents"]["missed"], 1);
    assert_eq!(a["missedBySource"].as_array().unwrap().len(), 1);
}

#[test]
fn csv_export_has_headers_and_quotes_delimiters() {
    let s = Scratch::new("csv");
    s.db
        .save_task(&TaskInput {
            title: "Ship, then \"verify\"\nsecond line".into(),
            notes: "plain".into(),
            ..Default::default()
        })
        .unwrap();
    let csv = s.db.export_csv("tasks").unwrap();
    let mut lines = csv.lines();
    let header = lines.next().unwrap();
    assert!(header.starts_with("id,title,notes"), "unexpected header: {header}");
    let row = lines.next().unwrap();
    assert!(row.contains("\"Ship, then \"\"verify\"\""), "commas and quotes must be escaped: {row}");
    assert!(csv.lines().count() >= 2);

    assert!(s.db.export_csv("secrets").is_err(), "only known tables may be exported");
}

#[test]
fn backup_writes_a_readable_copy_and_refuses_to_clobber() {
    let s = Scratch::new("backup");
    task(&s.db, "in the backup", None);
    let dest = s.path().join("snapshot.db");
    let bytes = s.db.backup_to(&dest).unwrap();
    assert!(bytes > 4096, "backup should contain real pages, got {bytes}");

    let check = rusqlite::Connection::open(&dest).unwrap();
    let n: i64 = check.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "backup must contain the committed rows");
    let mode: String = check.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode.to_lowercase(), "delete", "VACUUM INTO output is a plain, WAL-free file");
    drop(check);

    assert!(s.db.backup_to(&dest).is_err(), "an existing file must never be overwritten");
    assert!(s.db.backup_to(&s.path().join("weird dir/nested.db")).is_err(), "missing parent dir should fail cleanly");
}

#[test]
fn integrity_check_and_wal_checkpoint_succeed() {
    let s = Scratch::new("integrity");
    for i in 0..50 {
        task(&s.db, &format!("bulk {i}"), None);
    }
    assert_eq!(s.db.integrity_check().unwrap(), "ok");
    assert_eq!(s.db.quick_check().unwrap(), "ok");
    let (busy, _log, _checkpointed) = s.db.wal_checkpoint().unwrap();
    assert_eq!(busy, 0, "checkpoint should complete when no reader holds the WAL");
    let wal = s.path().join("scratch.db-wal");
    let size = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    assert!(size <= 64, "TRUNCATE checkpoint should empty the WAL, got {size} bytes");
}

#[test]
fn json_snapshot_roundtrips_into_a_fresh_database() {
    let s = Scratch::new("snapshot");
    let now = chrono::Local::now().timestamp();
    let t = task(&s.db, "snapshotted task", Some(now));
    s.db.add_subtask(t.id, "a step").unwrap();
    alarm(&s.db, "snapshotted alarm", now + HOUR, "none");
    s.db.set_setting("theme", "light").unwrap();

    let raw = s.db.snapshot_json().unwrap();
    let dest = Scratch::new("snapshot-dest");
    let written = dest.db.restore_json(&raw).unwrap();
    assert!(written >= 4, "expected several rows restored, got {written}");
    assert_eq!(dest.db.list_tasks("", "").unwrap().len(), 1);
    assert_eq!(dest.db.list_alarms().unwrap().len(), 1);
    assert_eq!(dest.db.get_setting("theme").as_deref(), Some("light"));
    assert_eq!(dest.db.list_subtasks(t.id).unwrap().len(), 1);

    assert!(dest.db.restore_json("{ not json").is_err());
    assert!(dest.db.restore_json("{}").is_ok_and(|n| n == 0), "an empty object restores nothing");
}

#[test]
fn reset_workspace_clears_content_but_keeps_preferences() {
    let s = Scratch::new("reset");
    let now = chrono::Local::now().timestamp();
    let t = task(&s.db, "demo task", Some(now));
    s.db.add_subtask(t.id, "demo step").unwrap();
    alarm(&s.db, "demo alarm", now + HOUR, "none");
    s.db.set_setting("theme", "light").unwrap();
    s.db.set_setting("default_snooze", "15").unwrap();

    let removed = s.db.reset_workspace().unwrap();
    assert_eq!(removed["tasks"], serde_json::json!(1));
    assert_eq!(removed["subtasks"], serde_json::json!(1));
    assert_eq!(removed["alarms"], serde_json::json!(1));

    assert!(s.db.list_tasks("", "").unwrap().is_empty(), "content must be gone");
    assert!(s.db.list_alarms().unwrap().is_empty());
    assert_eq!(s.db.get_setting("theme").as_deref(), Some("light"), "preferences must survive");
    assert_eq!(s.db.get_setting("default_snooze").as_deref(), Some("15"));
    assert_eq!(s.db.stats().unwrap().tasks_total, 0);

    // The FTS index is rebuilt empty, so a stale hit cannot survive a reset.
    assert!(s.db.search_tasks("demo", 10).unwrap().is_empty());

    // And the workspace is usable again afterwards.
    let fresh = task(&s.db, "my own task", Some(now));
    assert_eq!(s.db.list_tasks("", "").unwrap().len(), 1);
    assert_eq!(s.db.search_tasks("own", 10).unwrap().len(), 1, "index accepts new rows");
    assert_eq!(s.db.search_tasks("demo", 10).unwrap().len(), 0, "cleared content must not linger in the index");
    assert!(fresh.id > t.id, "ids keep advancing rather than colliding");
}

#[test]
fn history_pruning_keeps_recent_rows() {
    let s = Scratch::new("prune");
    let now = chrono::Local::now().timestamp();
    alarm(&s.db, "kept", now - 10, "none");
    {
        let c = s.db.conn.lock().unwrap();
        c.execute(
            "INSERT INTO alarm_history(alarm_id,label,event,due_at,at,note) VALUES(NULL,'ancient','fired',?1,?2,'old')",
            rusqlite::params![now - 400 * DAY, now - 400 * DAY],
        )
        .unwrap();
    }
    assert_eq!(s.db.list_alarm_history(None, 50).unwrap().len(), 2);
    let (removed, _) = s.db.prune_history(90).unwrap();
    assert_eq!(removed, 1);
    assert_eq!(s.db.list_alarm_history(None, 50).unwrap().len(), 1);
}

#[test]
fn stats_and_storage_report_reflect_the_data() {
    let s = Scratch::new("report");
    let now = chrono::Local::now().timestamp();
    task(&s.db, "today one", Some(noon_today()));
    task(&s.db, "overdue one", Some(now - DAY));
    let st = s.db.stats().unwrap();
    assert_eq!(st.due_today, 1);
    assert_eq!(st.overdue, 1);
    assert_eq!(st.tasks_total, 2);

    let report = s.db.storage_report().unwrap();
    assert_eq!(report["journalMode"], "wal");
    assert_eq!(report["rowCounts"]["tasks"], 2);
    assert!(report["tables"].as_array().unwrap().contains(&serde_json::json!("missed_alarms")));
    assert!(report["bytes"].as_i64().unwrap() > 0);
}

#[test]
fn cascade_delete_removes_children() {
    let s = Scratch::new("cascade");
    let t = task(&s.db, "parent", None);
    let a = s.db.save_alarm(&AlarmInput { label: "linked".into(), fire_at: chrono::Local::now().timestamp() + HOUR, task_id: Some(t.id), ..Default::default() }).unwrap();
    s.db.add_subtask(t.id, "child step").unwrap();
    assert_eq!(s.db.list_subtasks(t.id).unwrap().len(), 1);

    s.db.delete_task(t.id).unwrap();
    assert!(s.db.list_subtasks(t.id).unwrap().is_empty(), "subtasks must cascade");
    assert_eq!(s.db.alarm_by_id(a.id).unwrap().task_id, None, "alarm must detach, not vanish");
}

#[test]
fn a_fresh_database_starts_empty_but_preferences_exist() {
    // The demo workspace is gone: a new install must not ship with someone else's tasks.
    let dir = scratch_dir("empty");
    let db = dj_task_manager_lib::db::Db::open(&dir).expect("open app db");
    assert!(db.list_tasks("", "").unwrap().is_empty(), "no tasks should be pre-seeded");
    assert!(db.list_alarms().unwrap().is_empty(), "no alarms should be pre-seeded");
    assert!(db.list_missed(false).unwrap().is_empty());
    assert!(db.list_activity(None, 10).unwrap().is_empty());
    // Preferences do have defaults, so the toggles read back real values.
    assert_eq!(db.get_setting("theme").as_deref(), Some("dark"));
    assert_eq!(db.get_setting("autostart").as_deref(), Some("true"));
    assert_eq!(db.stats().unwrap().tasks_total, 0);
    let report = db.storage_report().unwrap();
    assert_eq!(report["rowCounts"]["tasks"], serde_json::json!(0));
    cleanup(dir);
}

#[test]
fn snoozing_a_recurring_alarm_keeps_its_daily_slot() {
    // Regression: snooze used to rewrite fire_at, so snoozing a 09:45 standup in the
    // evening moved every future standup to that new time, permanently.
    let s = Scratch::new("snooze-schedule");
    let now = chrono::Local::now().timestamp();
    let slot = now - HOUR; // a daily alarm whose slot passed an hour ago
    let a = alarm(&s.db, "Standup sync", slot, "daily");

    let snoozed = s.db.snooze_alarm(a.id, 45).unwrap();
    assert_eq!(snoozed.fire_at, slot, "the recurring slot must be untouched");
    assert_eq!(snoozed.snoozed_until, Some(now + 45 * MIN), "suppression is a separate window");
    assert!(snoozed.next_fire_at.unwrap() > now, "and it must not be due yet");
    assert_eq!(snoozed.snooze_count, 1);

    // Half an hour later the snooze is still holding it back.
    let early = scheduler::evaluate_due(&s.db, now + 30 * MIN, now, scheduler::GRACE_SECONDS).unwrap();
    assert!(early.iter().all(|e| e.id != a.id), "a pending snooze must hold the alarm back");

    // Past the window it fires once, and the schedule is still where it was set.
    let due = scheduler::evaluate_due(&s.db, now + 46 * MIN, now, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(due.len(), 1, "the alarm should come due once the window passes");
    assert_eq!(due[0].kind, "fired", "it fires promptly, so it is not a miss");

    let after = s.db.alarm_by_id(a.id).unwrap();
    assert_eq!(after.fire_at, slot, "firing must not move the stored slot either");
    assert_eq!(after.snoozed_until, None, "consuming the snooze clears it");
    assert!(after.next_fire_at.unwrap() > now + 46 * MIN, "and it rolls to the next day");
}

#[test]
fn snoozing_a_one_off_alarm_does_move_its_slot() {
    let s = Scratch::new("snooze-oneoff");
    let now = chrono::Local::now().timestamp();
    let a = alarm(&s.db, "Code freeze", now - 60, "none");
    let after = s.db.snooze_alarm(a.id, 15).unwrap();
    assert!(after.fire_at >= now + 15 * 60 - 5, "a one-off reschedules");
    assert_eq!(after.snoozed_until, None, "one-offs use fire_at, not the suppression window");
    assert_eq!(after.state, "armed");
}

#[test]
fn firing_clears_the_snooze_window() {
    let s = Scratch::new("snooze-clear");
    let now = chrono::Local::now().timestamp();
    let a = alarm(&s.db, "Daily standup", now - 30, "daily");
    s.db.snooze_alarm(a.id, 5).unwrap();
    assert!(s.db.alarm_by_id(a.id).unwrap().snoozed_until.is_some());

    let fire_at = now + 6 * 60;
    let events = scheduler::evaluate_due(&s.db, fire_at, fire_at, scheduler::GRACE_SECONDS).unwrap();
    assert_eq!(events.len(), 1, "the snoozed alarm should come due once the window passes");
    let after = s.db.alarm_by_id(a.id).unwrap();
    assert_eq!(after.snoozed_until, None, "consuming the snooze must clear it");
    assert_eq!(after.fire_at, a.fire_at, "and the schedule stays where it was set");
}

#[test]
fn deleting_a_task_disarms_the_alarm_attached_to_it() {
    let s = Scratch::new("disarm");
    let task = s
        .db
        .save_task(&TaskInput {
            title: "Ship the release".into(),
            ..Default::default()
        })
        .unwrap();
    let attached = s
        .db
        .save_alarm(&AlarmInput {
            label: "Reminder: Ship the release".into(),
            fire_at: noon_today() + HOUR,
            task_id: Some(task.id),
            ..Default::default()
        })
        .unwrap();
    let standalone = s
        .db
        .save_alarm(&AlarmInput {
            label: "Standup".into(),
            fire_at: noon_today(),
            repeat: "weekdays".into(),
            ..Default::default()
        })
        .unwrap();

    s.db.delete_task(task.id).unwrap();

    // No ghost alarms: the reminder must stop firing once its task is gone...
    let armed: Vec<i64> = s
        .db
        .armed_alarms()
        .unwrap()
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert!(
        !armed.contains(&attached.id),
        "an alarm left pointing at a deleted task must not stay armed"
    );
    // ...but it is disarmed, not destroyed, and nothing else is touched.
    let after = s.db.alarm_by_id(attached.id).unwrap();
    assert_eq!(after.state, "paused", "the reminder survives as a paused alarm");
    assert_eq!(after.task_id, None, "and it is detached from the task that went away");
    assert_eq!(
        s.db.alarm_by_id(standalone.id).unwrap().state,
        standalone.state,
        "an alarm with no task must never be collateral damage"
    );

    let history = s.db.list_alarm_history(None, 50).unwrap();
    assert!(
        history
            .iter()
            .any(|h| h.event == "paused" && h.label == attached.label && h.note == "task removed"),
        "the disarm has to be auditable, got {:?}",
        history.iter().map(|h| (&h.event, &h.label)).collect::<Vec<_>>()
    );
}
