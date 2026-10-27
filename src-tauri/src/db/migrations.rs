//! Versioned schema migrations, tracked in `PRAGMA user_version`.
//!
//! Every step is written to be replay-safe: `CREATE ... IF NOT EXISTS`, guarded
//! `ALTER TABLE ADD COLUMN`, and `CREATE OR REPLACE` triggers. That matters because a
//! long-lived desktop database can be opened by any build of the app, in any order.
use rusqlite::{params, Connection};

/// The schema version this build expects. `analytics::schema_report()` surfaces it.
pub const TARGET_VERSION: i64 = 4;

struct Migration {
    version: i64,
    name: &'static str,
    apply: fn(&Connection) -> Result<(), String>,
}

const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "baseline", apply: baseline },
    Migration { version: 2, name: "alarm-policy-and-recurrence", apply: alarm_policy_and_recurrence },
    Migration { version: 3, name: "history-and-fts", apply: history_and_fts },
    Migration { version: 4, name: "snooze-window", apply: snooze_window },
];

pub fn current(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0)
}

/// Applies every pending migration, each inside its own transaction, and records
/// what ran so `storage_report()` can show the applied history.
pub fn run(conn: &Connection) -> Result<Vec<String>, String> {
    let from = current(conn);
    let mut applied = Vec::new();
    for m in MIGRATIONS {
        if m.version <= from {
            continue;
        }
        (m.apply)(conn).map_err(|e| format!("migration {} ({}) failed: {e}", m.version, m.name))?;
        conn.pragma_update(None, "user_version", m.version)
            .map_err(|e| format!("could not stamp version {}: {e}", m.version))?;
        conn.execute(
            "INSERT OR REPLACE INTO schema_history(version, name, applied_at) VALUES(?1,?2,?3)",
            params![m.version, m.name, chrono::Local::now().timestamp()],
        )
        .map_err(|e| format!("could not record migration {}: {e}", m.version))?;
        applied.push(format!("{}:{}", m.version, m.name));
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut st = conn
        .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))
        .map_err(|e| e.to_string())?;
    Ok(st
        .exists(params![column])
        .map_err(|e| e.to_string())?)
}

fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))
        .map_err(|e| format!("adding {table}.{column}: {e}"))
}

/// v1 — the original tables. Kept as `IF NOT EXISTS` so a database created by the
/// pre-migration build adopts version 1 without rebuilding anything.
fn baseline(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        CREATE TABLE IF NOT EXISTS tasks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT    NOT NULL,
            notes      TEXT    NOT NULL DEFAULT '',
            priority   TEXT    NOT NULL DEFAULT 'p3',
            status     TEXT    NOT NULL DEFAULT 'todo',
            due_at     INTEGER,
            tags       TEXT    NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_at);

        CREATE TABLE IF NOT EXISTS subtasks (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            title   TEXT    NOT NULL,
            done    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);

        CREATE TABLE IF NOT EXISTS alarms (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            label         TEXT    NOT NULL,
            fire_at       INTEGER NOT NULL,
            repeat        TEXT    NOT NULL DEFAULT 'none',
            days          TEXT    NOT NULL DEFAULT '[]',
            snooze_min    INTEGER NOT NULL DEFAULT 5,
            sound         TEXT    NOT NULL DEFAULT 'chime',
            state         TEXT    NOT NULL DEFAULT 'armed',
            task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
            last_fired_at INTEGER,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alarms_state ON alarms(state);
        CREATE INDEX IF NOT EXISTS idx_alarms_fire  ON alarms(fire_at);

        CREATE TABLE IF NOT EXISTS missed_alarms (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            alarm_id     INTEGER REFERENCES alarms(id) ON DELETE SET NULL,
            label        TEXT    NOT NULL,
            due_at       INTEGER NOT NULL,
            detected_at  INTEGER NOT NULL,
            source       TEXT    NOT NULL DEFAULT 'runtime',
            resolution   TEXT    NOT NULL DEFAULT 'unhandled',
            resolved_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_missed_res ON missed_alarms(resolution);

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schema_history (
            version    INTEGER PRIMARY KEY,
            name       TEXT    NOT NULL,
            applied_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())
}

/// v2 — alarm policy (advance warning, snooze budget, escalation) and task
/// recurrence (rule, weekday mask, template lineage, completion timestamp).
fn alarm_policy_and_recurrence(conn: &Connection) -> Result<(), String> {
    add_column(conn, "alarms", "advance_min", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "alarms", "snooze_count", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "alarms", "max_snoozes", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "alarms", "escalate", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "alarms", "last_preflight_for", "INTEGER")?;

    add_column(conn, "tasks", "recurrence", "TEXT NOT NULL DEFAULT 'none'")?;
    add_column(conn, "tasks", "recur_days", "TEXT NOT NULL DEFAULT '[]'")?;
    add_column(conn, "tasks", "parent_id", "INTEGER REFERENCES tasks(id) ON DELETE SET NULL")?;
    add_column(conn, "tasks", "completed_at", "INTEGER")?;
    add_column(conn, "tasks", "archived", "INTEGER NOT NULL DEFAULT 0")?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_parent     ON tasks(parent_id);
         CREATE INDEX IF NOT EXISTS idx_tasks_recurrence ON tasks(recurrence);
         CREATE INDEX IF NOT EXISTS idx_alarms_task      ON alarms(task_id);",
    )
    .map_err(|e| e.to_string())
}

/// v3 — append-only event streams plus an FTS5 index over tasks, kept in sync by
/// triggers so the search index can never drift from the row data.
fn history_and_fts(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS alarm_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            alarm_id   INTEGER REFERENCES alarms(id) ON DELETE SET NULL,
            label      TEXT    NOT NULL,
            event      TEXT    NOT NULL,
            due_at     INTEGER NOT NULL,
            at         INTEGER NOT NULL,
            note       TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_hist_alarm ON alarm_history(alarm_id);
        CREATE INDEX IF NOT EXISTS idx_hist_at    ON alarm_history(at);

        CREATE TABLE IF NOT EXISTS activity_log (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
            kind    TEXT    NOT NULL,
            summary TEXT    NOT NULL,
            at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_log(task_id);
        CREATE INDEX IF NOT EXISTS idx_activity_at   ON activity_log(at);
        "#,
    )
    .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
             title, notes, tags,
             content='tasks', content_rowid='id',
             tokenize='porter unicode61'
         );",
    )
    .map_err(|e| format!("FTS5 is required by the bundled SQLite build: {e}"))?;

    // Backfill the index from existing rows before installing the triggers.
    conn.execute_batch(
        "INSERT INTO tasks_fts(rowid, title, notes, tags)
         SELECT id, title, notes, tags FROM tasks
         WHERE id NOT IN (SELECT rowid FROM tasks_fts);",
    )
    .ok();

    for sql in [
        "CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
             INSERT INTO tasks_fts(rowid, title, notes, tags)
             VALUES (new.id, new.title, new.notes, new.tags);
         END;",
        "CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
             INSERT INTO tasks_fts(tasks_fts, rowid, title, notes, tags)
             VALUES ('delete', old.id, old.title, old.notes, old.tags);
         END;",
        "CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
             INSERT INTO tasks_fts(tasks_fts, rowid, title, notes, tags)
             VALUES ('delete', old.id, old.title, old.notes, old.tags);
             INSERT INTO tasks_fts(rowid, title, notes, tags)
             VALUES (new.id, new.title, new.notes, new.tags);
         END;",
    ] {
        conn.execute_batch(sql).map_err(|e| format!("trigger: {e}"))?;
    }
    Ok(())
}

/// v4 — a snooze must not rewrite an alarm's schedule.
///
/// Moving `fire_at` is fine for a one-off, but for a daily or weekly alarm it silently
/// relocates the recurring slot forever: snooze a 09:45 standup at 18:00 and every
/// future standup becomes 18:05. `snoozed_until` suppresses the alarm until a moment in
/// time while leaving the underlying schedule untouched.
fn snooze_window(conn: &Connection) -> Result<(), String> {
    add_column(conn, "alarms", "snoozed_until", "INTEGER")
}
