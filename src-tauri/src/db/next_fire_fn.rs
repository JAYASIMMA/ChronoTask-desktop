//! Next-fire computation shared by the SQL layer and the scheduler thread.
//!
//! Registered as the SQLite scalar function `next_fire(fire_at, repeat, days_json, last_fired_at)`
//! so list queries and the tick loop always agree on when an alarm is due.
//!
//! The rule is anchored on `last_fired_at`, never on the wall clock: the first
//! occurrence strictly after the last one already handled. Anchoring on "now" instead
//! makes a recurring alarm un-fireable — its slot is always rolled past the current
//! second, so the scheduler's `due <= now` test never becomes true.
use chrono::{Datelike, Days, Local, NaiveTime, TimeZone};
use rusqlite::{functions::FunctionFlags, Connection};

use crate::db::recurrence::resolve;

pub fn compute(fire_at: i64, repeat: &str, days_json: &str, last_fired_at: Option<i64>) -> Option<i64> {
    match repeat {
        // A one-off alarm stays due until it is dismissed or snoozed.
        "none" | "" => Some(fire_at),
        "daily" => time_of(fire_at).map(|t| next_occurrence(t, None, anchor(fire_at, last_fired_at))),
        "weekdays" => time_of(fire_at).map(|t| {
            next_occurrence(t, Some(vec![0, 1, 2, 3, 4]), anchor(fire_at, last_fired_at))
        }),
        "weekly" => {
            let days: Vec<u32> = serde_json::from_str(days_json).unwrap_or_default();
            let days = if days.is_empty() {
                vec![Local::now().weekday().num_days_from_monday()]
            } else {
                days
            };
            time_of(fire_at).map(|t| next_occurrence(t, Some(days), anchor(fire_at, last_fired_at)))
        }
        _ => Some(fire_at),
    }
}

/// Nothing handled yet => the alarm's own slot is the first candidate.
fn anchor(fire_at: i64, last_fired_at: Option<i64>) -> i64 {
    last_fired_at.unwrap_or(fire_at - 1)
}

fn time_of(epoch: i64) -> Option<NaiveTime> {
    Local.timestamp_opt(epoch, 0).single().map(|d| d.time())
}

/// First occurrence of `time` on an allowed weekday strictly after `after`.
fn next_occurrence(time: NaiveTime, days: Option<Vec<u32>>, after: i64) -> i64 {
    let start = match Local.timestamp_opt(after, 0).single() {
        Some(dt) => dt.date_naive(),
        None => return after + 86_400,
    };
    let mut date = start;
    for _ in 0..371 {
        let allowed = match &days {
            Some(list) => list.contains(&date.weekday().num_days_from_monday()),
            None => true,
        };
        if allowed {
            if let Some(at) = resolve(date, time) {
                if at > after {
                    return at;
                }
            }
        }
        date = match date.checked_add_days(Days::new(1)) {
            Some(d) => d,
            None => break,
        };
    }
    after + 86_400
}

/// Not marked DETERMINISTIC: the result moves as occurrences are consumed.
pub fn register(conn: &Connection) {
    let result = conn.create_scalar_function(
        "next_fire",
        4,
        FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<i64> {
            let fire_at: i64 = ctx.get(0)?;
            let repeat: String = ctx.get(1)?;
            let days: String = ctx.get(2)?;
            let last: Option<i64> = ctx.get(3)?;
            Ok(compute(fire_at, &repeat, &days, last).unwrap_or(fire_at))
        },
    );
    if let Err(e) = result {
        eprintln!("[chronotask] could not register next_fire(): {e}");
    }
}

/// Convenience for callers holding parsed values (`days`: 0 = Monday .. 6 = Sunday).
pub fn compute_value(fire_at: i64, repeat: &str, days: &[u32], last_fired_at: Option<i64>) -> Option<i64> {
    compute(
        fire_at,
        repeat,
        &serde_json::to_string(days).unwrap_or_else(|_| "[]".into()),
        last_fired_at,
    )
}
