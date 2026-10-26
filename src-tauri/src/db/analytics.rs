//! Search, analytics, and database maintenance: FTS5 lookup over tasks, rollups the
//! UI charts, CSV export, and the operational pragmas (backup, integrity, checkpoint).
use crate::db::{now_epoch, Db};
use rusqlite::params;
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: i64,
    pub title: String,
    pub priority: String,
    pub status: String,
    pub due_at: Option<i64>,
    /// FTS5 `snippet()` output with <b>/<mark> markers around matched terms.
    pub snippet: String,
    pub score: f64,
    pub engine: String,
}

/// Turns free text into a safe FTS5 expression: every alphanumeric run becomes a
/// quoted prefix term, so operators (`AND`, `NEAR`, `"`, `*`, `-`) cannot change the
/// query's shape or produce a syntax error.
pub fn fts_expression(q: &str) -> String {
    q.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(" AND ")
}

impl Db {
    pub fn search_tasks(&self, query: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
        let limit = limit.clamp(1, 100);
        let expr = fts_expression(query);
        let c = self.lock()?;
        let mut out = Vec::new();

        if !expr.is_empty() {
            let mut st = c
                .prepare(
                    "SELECT t.id, t.title, t.priority, t.status, t.due_at,
                            snippet(tasks_fts, 0, '<b>', '</b>', '…', 12),
                            bm25(tasks_fts)
                     FROM tasks_fts
                     JOIN tasks t ON t.id = tasks_fts.rowid
                     WHERE tasks_fts MATCH ?1
                     ORDER BY bm25(tasks_fts)
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(params![expr, limit], |r| {
                    Ok(SearchHit {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        priority: r.get(2)?,
                        status: r.get(3)?,
                        due_at: r.get(4)?,
                        snippet: r.get(5)?,
                        score: r.get(6)?,
                        engine: "fts5".into(),
                    })
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                out.push(row.map_err(|e| e.to_string())?);
            }
        }

        // Substring matches that FTS tokenisation cannot see (a tag fragment, or a
        // infix inside a longer word) are appended so search never under-returns.
        if out.len() < limit as usize && !query.trim().is_empty() {
            let like = format!("%{}%", query.trim());
            let mut st = c
                .prepare(
                    "SELECT id, title, priority, status, due_at FROM tasks
                     WHERE title LIKE ?1 OR notes LIKE ?1 OR tags LIKE ?1
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let have: Vec<i64> = out.iter().map(|h| h.id).collect();
            let rows = st
                .query_map(params![like, limit * 3], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, title, priority, status, due_at) = row.map_err(|e| e.to_string())?;
                if have.contains(&id) || out.len() >= limit as usize {
                    continue;
                }
                out.push(SearchHit {
                    id,
                    snippet: title.clone(),
                    score: 0.0,
                    engine: "like".into(),
                    title,
                    priority,
                    status,
                    due_at,
                });
            }
        }
        Ok(out)
    }

    /// Everything the Settings analytics panel and the dashboard need, in one round trip.
    pub fn analytics(&self, days: i64) -> Result<serde_json::Value, String> {
        let days = days.clamp(1, 365);
        let since = now_epoch() - days * 86_400;
        let c = self.lock()?;

        let mut completions = Vec::new();
        {
            let mut st = c
                .prepare(
                    "SELECT date(completed_at, 'unixepoch', 'localtime') AS d, COUNT(*)
                     FROM tasks WHERE status = 'done' AND completed_at >= ?1
                     GROUP BY d ORDER BY d",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(params![since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (d, n) = row.map_err(|e| e.to_string())?;
                completions.push(json!({ "day": d, "count": n }));
            }
        }

        let on_time: (i64, i64) = c
            .query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN completed_at <= due_at THEN 1 ELSE 0 END), 0),
                    COUNT(*)
                 FROM tasks WHERE status = 'done' AND due_at IS NOT NULL AND completed_at IS NOT NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;

        let mut alarm_events = serde_json::Map::new();
        {
            let mut st = c
                .prepare("SELECT event, COUNT(*) FROM alarm_history WHERE at >= ?1 GROUP BY event")
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(params![since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (k, v) = row.map_err(|e| e.to_string())?;
                alarm_events.insert(k, json!(v));
            }
        }

        let mut missed_by_source = Vec::new();
        {
            let mut st = c
                .prepare(
                    "SELECT source, resolution, COUNT(*) FROM missed_alarms
                     WHERE detected_at >= ?1 GROUP BY source, resolution ORDER BY 3 DESC",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(params![since], |r| {
                    Ok(json!({ "source": r.get::<_, String>(0)?, "resolution": r.get::<_, String>(1)?, "count": r.get::<_, i64>(2)? }))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                missed_by_source.push(row.map_err(|e| e.to_string())?);
            }
        }

        let mut tags = Vec::new();
        {
            let mut st = c
                .prepare(
                    "SELECT j.value AS tag, COUNT(*) AS n
                     FROM tasks t, json_each(t.tags) j
                     GROUP BY j.value ORDER BY n DESC LIMIT 12",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| Ok(json!({ "tag": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)? })))
                .map_err(|e| e.to_string())?;
            for row in rows {
                tags.push(row.map_err(|e| e.to_string())?);
            }
        }

        let oldest = c
            .query_row("SELECT MIN(created_at) FROM tasks", [], |r| r.get::<_, Option<i64>>(0))
            .unwrap_or(None);

        Ok(json!({
            "windowDays": days,
            "since": since,
            "completions": completions,
            "onTime": {
                "onTime": on_time.0,
                "total": on_time.1,
                // Percentage with two decimals: 50.0 means half were finished on time.
                "rate": if on_time.1 > 0 {
                    ((on_time.0 as f64 / on_time.1 as f64) * 10_000.0).round() / 100.0
                } else {
                    0.0
                }
            },
            "alarmEvents": alarm_events,
            "missedBySource": missed_by_source,
            "topTags": tags,
            "oldestTaskAt": oldest,
            "generatedAt": now_epoch(),
        }))
    }

    /// RFC4180 CSV for the tables the user can export.
    pub fn export_csv(&self, table: &str) -> Result<String, String> {
        let allowed = ["tasks", "subtasks", "alarms", "missed_alarms", "alarm_history", "activity_log"];
        if !allowed.contains(&table) {
            return Err(format!("table must be one of {}", allowed.join(", ")));
        }
        let c = self.lock()?;
        let mut st = c
            .prepare(&format!("SELECT * FROM {table}"))
            .map_err(|e| e.to_string())?;
        let cols: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let ncols = cols.len();
        let mut out = String::new();
        out.push_str(&cols.iter().map(|s| csv_cell(s)).collect::<Vec<_>>().join(","));
        out.push('\n');
        let mut rows = st
            .query_map([], |r| {
                let mut v = Vec::with_capacity(ncols);
                for i in 0..ncols {
                    let val: rusqlite::types::Value = r.get_ref(i)?.into();
                    v.push(match val {
                        rusqlite::types::Value::Null => String::new(),
                        rusqlite::types::Value::Integer(x) => x.to_string(),
                        rusqlite::types::Value::Real(x) => x.to_string(),
                        rusqlite::types::Value::Text(s) => s,
                        rusqlite::types::Value::Blob(b) => format!("<blob {}>", b.len()),
                    });
                }
                Ok(v)
            })
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next() {
            let row = row.map_err(|e| e.to_string())?;
            out.push_str(&row.iter().map(|s| csv_cell(s)).collect::<Vec<_>>().join(","));
            out.push('\n');
        }
        Ok(out)
    }

    /// Online snapshot via `VACUUM INTO` — consistent without stopping the scheduler.
    pub fn backup_to(&self, dest: &std::path::Path) -> Result<u64, String> {
        if dest.exists() {
            return Err(format!("refusing to overwrite existing file: {}", dest.display()));
        }
        let escaped = dest.to_string_lossy().replace('\'', "''");
        let c = self.lock()?;
        c.execute_batch(&format!("VACUUM INTO '{escaped}'"))
            .map_err(|e| format!("VACUUM INTO failed: {e}"))?;
        drop(c);
        Ok(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0))
    }

    /// `PRAGMA integrity_check` — returns "ok" for a healthy database.
    pub fn integrity_check(&self) -> Result<String, String> {
        let c = self.lock()?;
        let msg = c
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|e| format!("check unavailable: {e}"));
        Ok(msg)
    }

    pub fn quick_check(&self) -> Result<String, String> {
        let c = self.lock()?;
        Ok(c
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|e| format!("check unavailable: {e}")))
    }

    /// Flushes the WAL into the main database file. Returns (busy, wal_frames, moved);
    /// `busy = 1` means a reader held a frame open, not that anything failed.
    pub fn wal_checkpoint(&self) -> Result<(i64, i64, i64), String> {
        let c = self.lock()?;
        let mut st = c
            .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|e| e.to_string())?;
        st.query_row([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
            .map_err(|e| e.to_string())
    }

    /// Empties every content table but leaves `settings` (theme, defaults) intact, so a
    /// first-run demo workspace can be swapped for the user's own data in one action.
    /// Returns the number of rows removed per table.
    pub fn reset_workspace(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let mut removed = serde_json::Map::new();
        let mut guard = self.lock()?;
        let tx = guard.transaction().map_err(|e| e.to_string())?;
        // Children first: the cascades would otherwise be relied on implicitly.
        for table in ["subtasks", "alarm_history", "activity_log", "missed_alarms", "alarms", "tasks"] {
            let n = tx
                .execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| format!("clearing {table}: {e}"))?;
            removed.insert(table.to_string(), json!(n));
        }
        // Re-sync the FTS index: the delete triggers already emptied it, but this makes
        // the invariant explicit and repairs any drift from a hand-edited database.
        tx.execute("INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')", [])
            .map_err(|e| format!("fts rebuild: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(guard);
        self.log_activity(None, "reset", "workspace cleared, settings kept");
        Ok(removed)
    }

    /// Applied migrations plus the indexes the query layer relies on.
    pub fn schema_report(&self) -> Result<serde_json::Value, String> {
        let c = self.lock()?;
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        let mut applied = Vec::new();
        {
            let mut st = c
                .prepare("SELECT version, name, applied_at FROM schema_history ORDER BY version")
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| {
                    Ok(json!({ "version": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "at": r.get::<_, i64>(2)? }))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                applied.push(row.map_err(|e| e.to_string())?);
            }
        }
        let mut indexes = Vec::new();
        {
            let mut st = c
                .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name")
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| Ok(json!({ "name": r.get::<_, String>(0)?, "table": r.get::<_, String>(1)? })))
                .map_err(|e| e.to_string())?;
            for row in rows {
                indexes.push(row.map_err(|e| e.to_string())?);
            }
        }
        let fts_present: bool = c
            .query_row("SELECT 1 FROM sqlite_master WHERE name = 'tasks_fts'", [], |r| r.get::<_, i64>(0))
            .is_ok();
        Ok(json!({
            "userVersion": version,
            "targetVersion": crate::db::migrations::TARGET_VERSION,
            "upToDate": version >= crate::db::migrations::TARGET_VERSION,
            "applied": applied,
            "indexes": indexes,
            "fts5": fts_present,
        }))
    }
}

/// Quote a CSV field when it contains a delimiter, quote, or newline.
fn csv_cell(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\n') || v.contains('\r') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::fts_expression;

    #[test]
    fn neutralises_fts_operators() {
        assert_eq!(fts_expression("hello world"), "\"hello\"* AND \"world\"*");
        // A user typing FTS syntax must not change the query shape.
        assert_eq!(fts_expression("NEAR(a b)"), "\"NEAR\"* AND \"a\"* AND \"b\"*");
        assert_eq!(fts_expression("\"quoted\""), "\"quoted\"*");
        assert_eq!(fts_expression("   "), "");
        assert_eq!(fts_expression("ipc-handler"), "\"ipc\"* AND \"handler\"*");
    }

    #[test]
    fn csv_quotes_only_when_needed() {
        use super::csv_cell;
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("line\nbreak"), "\"line\nbreak\"");
    }
}
