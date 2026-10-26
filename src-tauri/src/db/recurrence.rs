//! Recurring tasks.
//!
//! A recurring task keeps its own row as the schedule: completing it archives a
//! point-in-time snapshot of the finished occurrence and rolls the row's due date
//! forward to the next slot. That gives one visible task (no duplicates in the list),
//! a real completion history for analytics, and a checklist that resets per period.
use crate::db::{now_epoch, Task};
use chrono::{Datelike, Local, NaiveTime, TimeZone};
use rusqlite::params;

/// Next due time strictly after both `from` and `now`, preserving the time of day.
/// `days` uses 0 = Monday .. 6 = Sunday, matching `alarms.days`.
pub fn next_due(from: i64, recurrence: &str, days: &[u32], now: i64) -> Option<i64> {
    let base = Local.timestamp_opt(from, 0).single()?;
    let time = base.time();
    let floor = from.max(now);
    let mut date = base.date_naive();
    for _ in 0..400 {
        date = date.checked_add_days(chrono::Days::new(1))?;
        let weekday = date.weekday().num_days_from_monday();
        let allowed = match recurrence {
            "daily" => true,
            "weekdays" => weekday < 5,
            "weekly" => days.is_empty() || days.contains(&weekday),
            _ => return None,
        };
        if !allowed {
            continue;
        }
        if let Some(at) = resolve(date, time) {
            if at > floor {
                return Some(at);
            }
        }
    }
    None
}

/// Local wall clock -> epoch. Ambiguous times (fall-back DST) take the earlier
/// instant; nonexistent times (spring-forward) shift an hour so the occurrence still
/// lands near the intended slot instead of silently vanishing.
pub fn resolve(date: chrono::NaiveDate, time: NaiveTime) -> Option<i64> {
    let naive = date.and_time(time);
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.timestamp()),
        chrono::LocalResult::Ambiguous(earlier, _) => Some(earlier.timestamp()),
        chrono::LocalResult::None => match Local.from_local_datetime(&(naive + chrono::Duration::hours(1))) {
            chrono::LocalResult::Single(dt) => Some(dt.timestamp()),
            chrono::LocalResult::Ambiguous(a, _) => Some(a.timestamp()),
            chrono::LocalResult::None => None,
        },
    }
}

impl crate::db::Db {
    /// Archives the finished occurrence and advances the template. Returns the rolled
    /// forward task, or `None` when `task` is not recurring.
    pub fn roll_forward_recurring(&self, task: &Task) -> Result<Option<Task>, String> {
        if task.recurrence == "none" || task.recurrence.is_empty() {
            return Ok(None);
        }
        let due = task
            .due_at
            .ok_or_else(|| "a recurring task needs a due date to repeat".to_string())?;
        let now = now_epoch();
        let next = next_due(due, &task.recurrence, &task.recur_days, now)
            .ok_or_else(|| "no future occurrence found for this recurrence rule".to_string())?;

        let c = self.lock()?;
        // 1. Snapshot the occurrence exactly as it finished, hidden from the list.
        c.execute(
            "INSERT INTO tasks(title, notes, priority, status, due_at, tags, created_at, updated_at,
                               recurrence, recur_days, parent_id, completed_at, archived)
             SELECT title, notes, priority, 'done', due_at, tags, created_at, ?1,
                    'none', '[]', ?2, ?1, 1
             FROM tasks WHERE id = ?3",
            params![now, task.id, task.id],
        )
        .map_err(|e| format!("snapshotting occurrence: {e}"))?;
        let snapshot = c.last_insert_rowid();

        // 2. Carry the checklist state into the snapshot, then reset the live one.
        c.execute(
            "INSERT INTO subtasks(task_id, title, done) SELECT ?1, title, done FROM subtasks WHERE task_id = ?2",
            params![snapshot, task.id],
        )
        .map_err(|e| e.to_string())?;
        c.execute("UPDATE subtasks SET done = 0 WHERE task_id = ?1", params![task.id])
            .map_err(|e| e.to_string())?;

        // 3. Roll the schedule forward.
        c.execute(
            "UPDATE tasks SET due_at = ?1, status = 'todo', completed_at = NULL, updated_at = ?2 WHERE id = ?3",
            params![next, now, task.id],
        )
        .map_err(|e| e.to_string())?;
        drop(c);

        self.log_activity(
            Some(task.id),
            "recurrence",
            &format!("occurrence archived as task {snapshot}; next due at {next}"),
        );
        Ok(Some(self.task_by_id(task.id)?))
    }

    /// Advances recurring tasks whose due date lapsed while the app was closed, so a
    /// daily task is never stuck showing five stale days.
    pub fn catch_up_recurring(&self) -> Result<usize, String> {
        let stale: Vec<Task> = {
            let c = self.lock()?;
            let mut st = c
                .prepare(&format!(
                    "{} WHERE t.recurrence != 'none' AND t.due_at IS NOT NULL AND t.due_at < ?1",
                    crate::db::Db::TASK_SELECT
                ))
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(params![now_epoch()], crate::db::Db::row_to_task)
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut moved = 0;
        for t in stale {
            let Some(due) = t.due_at else { continue };
            // Step forward until the slot is in the future; bounded by next_due itself.
            let mut cursor = due;
            for _ in 0..400 {
                match next_due(cursor, &t.recurrence, &t.recur_days, now_epoch()) {
                    Some(n) if n > now_epoch() => {
                        cursor = n;
                        break;
                    }
                    Some(n) => cursor = n,
                    None => break,
                }
            }
            if cursor != due {
                let c = self.lock()?;
                c.execute(
                    "UPDATE tasks SET due_at = ?1, status = 'todo', completed_at = NULL, updated_at = ?2 WHERE id = ?3",
                    params![cursor, now_epoch(), t.id],
                )
                .map_err(|e| e.to_string())?;
                drop(c);
                self.log_activity(
                    Some(t.id),
                    "recurrence",
                    &format!("skipped {} missed occurrence(s)", ((cursor - due) / 86_400).max(1)),
                );
                moved += 1;
            }
        }
        Ok(moved)
    }

    /// Archived occurrence snapshots, newest first — the audit trail behind
    /// `analytics::completions`.
    pub fn list_occurrences(&self, limit: i64) -> Result<Vec<Task>, String> {
        let c = self.lock()?;
        let mut st = c
            .prepare(&format!(
                "{} WHERE t.archived = 1 ORDER BY t.completed_at DESC LIMIT ?1",
                crate::db::Db::TASK_SELECT
            ))
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![limit.clamp(1, 500)], crate::db::Db::row_to_task)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::next_due;
    use chrono::{Local, TimeZone};

    fn epoch(y: i32, mo: u32, d: u32, hh: u32, mi: u32) -> i64 {
        Local.with_ymd_and_hms(y, mo, d, hh, mi, 0).single().unwrap().timestamp()
    }

    #[test]
    fn daily_skips_to_tomorrow_when_time_has_passed() {
        let from = epoch(2026, 10, 26, 9, 0);
        let now = epoch(2026, 10, 26, 18, 0);
        assert_eq!(next_due(from, "daily", &[], now), Some(epoch(2026, 10, 27, 9, 0)));
    }

    #[test]
    fn daily_keeps_today_when_time_is_still_ahead() {
        let from = epoch(2026, 10, 20, 9, 0);
        let now = epoch(2026, 10, 26, 8, 0);
        assert_eq!(next_due(from, "daily", &[], now), Some(epoch(2026, 10, 26, 9, 0)));
    }

    #[test]
    fn weekdays_jumps_the_weekend() {
        // Friday 23 Oct 2026 17:00 -> Monday 26 Oct.
        assert_eq!(
            next_due(epoch(2026, 10, 23, 17, 0), "weekdays", &[], epoch(2026, 10, 23, 18, 0)),
            Some(epoch(2026, 10, 26, 17, 0))
        );
    }

    #[test]
    fn weekly_honours_the_day_mask() {
        // Mon 26 Oct 2026, allowed = Thursday only -> 29 Oct.
        assert_eq!(
            next_due(epoch(2026, 10, 26, 10, 0), "weekly", &[3], epoch(2026, 10, 26, 11, 0)),
            Some(epoch(2026, 10, 29, 10, 0))
        );
    }

    #[test]
    fn unknown_recurrence_produces_nothing() {
        assert_eq!(next_due(epoch(2026, 10, 26, 9, 0), "monthly", &[], 0), None);
    }
}
