//! Append-only event streams: what every alarm did, and what changed on every task.
//! The scheduler writes here so the UI can show a real audit trail instead of only
//! the current state, and so `analytics` can compute reliability from facts.
use rusqlite::params;
use serde::Serialize;

/// Every state transition an alarm can go through, including how a catch-up entry was
/// resolved.
pub const ALARM_EVENTS: &[&str] = &[
    "armed", "fired", "missed", "preflight", "snoozed", "dismissed", "paused", "resumed", "disabled",
    "acknowledged",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmEventRow {
    pub id: i64,
    pub alarm_id: Option<i64>,
    pub label: String,
    pub event: String,
    pub due_at: i64,
    pub at: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: i64,
    pub task_id: Option<i64>,
    pub kind: String,
    pub summary: String,
    pub at: i64,
}

impl crate::db::Db {
    pub fn record_alarm_event(
        &self,
        alarm_id: Option<i64>,
        label: &str,
        event: &str,
        due_at: i64,
        note: &str,
    ) -> Result<(), String> {
        debug_assert!(ALARM_EVENTS.contains(&event), "unknown alarm event: {event}");
        let c = self.lock()?;
        c.execute(
            "INSERT INTO alarm_history(alarm_id,label,event,due_at,at,note) VALUES(?1,?2,?3,?4,?5,?6)",
            params![alarm_id, label, event, due_at, crate::db::now_epoch(), note],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_alarm_history(&self, alarm_id: Option<i64>, limit: i64) -> Result<Vec<AlarmEventRow>, String> {
        let c = self.lock()?;
        let limit = limit.clamp(1, 500);
        let mut out = Vec::new();
        match alarm_id {
            Some(id) => {
                let mut st = c
                    .prepare(
                        "SELECT id, alarm_id, label, event, due_at, at, note FROM alarm_history
                         WHERE alarm_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = st.query_map(params![id, limit], Self::row_to_alarm_event).map_err(|e| e.to_string())?;
                for r in rows {
                    out.push(r.map_err(|e| e.to_string())?);
                }
            }
            None => {
                let mut st = c
                    .prepare(
                        "SELECT id, alarm_id, label, event, due_at, at, note FROM alarm_history
                         ORDER BY at DESC, id DESC LIMIT ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = st.query_map(params![limit], Self::row_to_alarm_event).map_err(|e| e.to_string())?;
                for r in rows {
                    out.push(r.map_err(|e| e.to_string())?);
                }
            }
        }
        Ok(out)
    }

    fn row_to_alarm_event(r: &rusqlite::Row) -> rusqlite::Result<AlarmEventRow> {
        Ok(AlarmEventRow {
            id: r.get(0)?,
            alarm_id: r.get(1)?,
            label: r.get(2)?,
            event: r.get(3)?,
            due_at: r.get(4)?,
            at: r.get(5)?,
            note: r.get(6)?,
        })
    }

    /// Records a task mutation. Failures are swallowed on purpose: an audit write must
    /// never be the reason a user's save fails.
    pub fn log_activity(&self, task_id: Option<i64>, kind: &str, summary: &str) {
        if let Ok(c) = self.lock() {
            let _ = c.execute(
                "INSERT INTO activity_log(task_id,kind,summary,at) VALUES(?1,?2,?3,?4)",
                params![task_id, kind, summary, crate::db::now_epoch()],
            );
        }
    }

    pub fn list_activity(&self, task_id: Option<i64>, limit: i64) -> Result<Vec<ActivityRow>, String> {
        let c = self.lock()?;
        let limit = limit.clamp(1, 500);
        let sql = match task_id {
            Some(_) => "SELECT id, task_id, kind, summary, at FROM activity_log WHERE task_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
            None => "SELECT id, task_id, kind, summary, at FROM activity_log ORDER BY at DESC, id DESC LIMIT ?2",
        };
        let mut st = c.prepare(sql).map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![task_id.unwrap_or(0), limit], |r| {
                Ok(ActivityRow {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    kind: r.get(2)?,
                    summary: r.get(3)?,
                    at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Trims the event streams; they grow without bound otherwise.
    pub fn prune_history(&self, keep_days: i64) -> Result<(usize, usize), String> {
        let cutoff = crate::db::now_epoch() - keep_days.max(1) * 86_400;
        let c = self.lock()?;
        let h = c
            .execute("DELETE FROM alarm_history WHERE at < ?1", params![cutoff])
            .map_err(|e| e.to_string())?;
        let a = c
            .execute("DELETE FROM activity_log WHERE at < ?1", params![cutoff])
            .map_err(|e| e.to_string())?;
        Ok((h, a))
    }
}
