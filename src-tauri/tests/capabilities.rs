//! Capability probes for the bundled SQLite engine.
//! These document which features ChronoTask may rely on, and fail loudly if a
//! future `bundled` upgrade drops one of them.
use rusqlite::Connection;

fn probe(label: &str, sql: &str) -> Result<String, String> {
    let c = Connection::open_in_memory().map_err(|e| e.to_string())?;
    match c.execute_batch(sql) {
        Ok(_) => Ok(format!("{label}: supported")),
        Err(e) => Err(format!("{label}: NOT supported ({e})")),
    }
}

#[test]
fn bundled_engine_supports_required_features() {
    let mut failures = Vec::new();

    // WAL journaling — the app runs with journal_mode=WAL.
    if let Err(e) = probe("wal", "PRAGMA journal_mode=WAL;") {
        failures.push(e);
    }
    // FTS5 — used by tasks_fts for title/notes search.
    if let Err(e) = probe(
        "fts5",
        "CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize='porter unicode61');",
    ) {
        failures.push(e);
    }
    // JSON1 — tags are stored as JSON arrays and queried with json_each.
    if let Err(e) = probe("json1", "SELECT json_extract('{\"a\":1}', '$.a');") {
        failures.push(e);
    }
    // Statement savepoints / transaction nesting used by the migration runner.
    if let Err(e) = probe("savepoint", "SAVEPOINT sp; RELEASE sp;") {
        failures.push(e);
    }

    assert!(
        failures.is_empty(),
        "bundled SQLite is missing features the backend needs:\n{}",
        failures.join("\n")
    );
}

#[test]
fn engine_version_is_modern() {
    let c = Connection::open_in_memory().unwrap();
    let v: String = c
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap();
    let parts: Vec<u32> = v.split('.').filter_map(|p| p.parse().ok()).collect();
    assert!(
        parts.first().map(|x| *x >= 3).unwrap_or(false) && parts.get(1).map(|x| *x >= 30).unwrap_or(false),
        "SQLite {v} is older than 3.30; window functions and ALTER TABLE DROP COLUMN are unavailable"
    );
}
