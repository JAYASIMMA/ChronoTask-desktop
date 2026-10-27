//! Background scheduler: one tick per second that fires due alarms, logs the ones
//! missed while the app was closed, sends advance warnings, and counts down the
//! focus timer.
//!
//! The decision logic lives in `evaluate_due` / `evaluate_preflight`, which take a
//! `&Db` and a clock instead of a Tauri handle. That keeps the whole policy unit
//! testable and leaves `tick` as thin transport code.
use crate::db::next_fire_fn;
use crate::db::Db;
use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// An alarm whose scheduled time passed more than this many seconds ago is treated as
/// missed (catch-up log) rather than fired late.
pub const GRACE_SECONDS: i64 = 90;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmEvent {
    pub id: i64,
    pub label: String,
    pub fire_at: i64,
    pub task_id: Option<i64>,
    pub task_title: Option<String>,
    pub snooze_min: i64,
    pub sound: String,
    pub escalating: bool,
    /// "fired" | "missed" | "preflight"
    pub kind: String,
    /// "offline" when the slot passed before this process started.
    pub source: String,
    pub logged_at: i64,
    /// Row in `missed_alarms` when this event came from the catch-up path.
    pub logged_id: Option<i64>,
}

pub fn spawn(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut next = Instant::now() + Duration::from_secs(1);
        loop {
            let until = next.saturating_duration_since(Instant::now());
            if !until.is_zero() {
                std::thread::sleep(until);
            }
            let late = Instant::now().saturating_duration_since(next).as_millis() as i64;
            // After sleep or hibernate `next` can lag by hours. Advancing it one second at
            // a time would spin the loop thousands of times, each doing database work, so
            // resync the schedule and take a single catch-up tick instead.
            if late > 2_000 {
                next = Instant::now() + Duration::from_secs(1);
            } else {
                next += Duration::from_secs(1);
            }
            state.record_drift(late.min(2_000));
            let ticks = state.ticks.fetch_add(1, Ordering::Relaxed) + 1;
            let now = chrono::Local::now().timestamp();
            if let Err(e) = tick(&app, &state, now, ticks) {
                eprintln!("[dj-task-manager] scheduler tick error: {e}");
            }
        }
    });
}

/// Fires and catches up alarms. Returns the events produced, already persisted.
pub fn evaluate_due(db: &Arc<Db>, now: i64, started_at: i64, grace: i64) -> Result<Vec<AlarmEvent>, String> {
    let mut events = Vec::new();
    for alarm in db.armed_alarms()? {
        let Some(due) = next_fire_fn::compute_value(
            alarm.fire_at,
            &alarm.repeat,
            &alarm.days,
            alarm.last_fired_at,
            alarm.snoozed_until,
        ) else {
            continue;
        };
        if due > now {
            continue;
        }
        let one_off = alarm.repeat == "none" || alarm.repeat.is_empty();
        let late = now - due;
        let missed = late > grace;
        let source = if due < started_at { "offline" } else { "runtime" }.to_string();

        let logged_id = if missed {
            db.log_missed(Some(alarm.id), &alarm.label, due, &source)?
        } else {
            // Only a genuinely delivered alarm counts as fired; a missed one is
            // recorded once, as "missed", so the reliability rollup stays honest.
            let _ = db.record_alarm_event(Some(alarm.id), &alarm.label, "fired", due, "");
            None
        };
        db.record_fire(alarm.id, due, one_off)?;

        events.push(AlarmEvent {
            id: alarm.id,
            label: alarm.label.clone(),
            fire_at: due,
            task_id: alarm.task_id,
            task_title: alarm.task_title.clone(),
            snooze_min: alarm.snooze_min,
            sound: alarm.sound.clone(),
            escalating: alarm.escalate,
            kind: if missed { "missed" } else { "fired" }.to_string(),
            source,
            logged_at: now,
            logged_id,
        });

        // Escalating alarms nag on their own instead of waiting for a manual snooze.
        if one_off && alarm.escalate {
            db.snooze_alarm(alarm.id, alarm.snooze_min)?;
        }
    }
    Ok(events)
}

/// Advance warnings: `advance_min` before the linked task is due, once per due date.
pub fn evaluate_preflight(db: &Arc<Db>, now: i64) -> Result<Vec<AlarmEvent>, String> {
    let mut events = Vec::new();
    for alarm in db.armed_alarms()? {
        if alarm.advance_min <= 0 {
            continue;
        }
        let Some(task_id) = alarm.task_id else { continue };
        let Ok(task) = db.task_by_id(task_id) else { continue };
        let Some(due) = task.due_at else { continue };
        let warn_at = due - alarm.advance_min * 60;
        if warn_at > now || alarm.last_preflight_for == Some(due) {
            continue;
        }
        db.set_preflight_sent(alarm.id, due)?;
        let _ = db.record_alarm_event(Some(alarm.id), &alarm.label, "preflight", warn_at, &format!("{}m early", alarm.advance_min));
        events.push(AlarmEvent {
            id: alarm.id,
            label: alarm.label.clone(),
            fire_at: warn_at,
            task_id: Some(task_id),
            task_title: Some(task.title),
            snooze_min: alarm.snooze_min,
            sound: alarm.sound.clone(),
            escalating: false,
            kind: "preflight".to_string(),
            source: "runtime".to_string(),
            logged_at: now,
            logged_id: None,
        });
    }
    Ok(events)
}

fn tick(app: &AppHandle, state: &Arc<AppState>, now: i64, ticks: i64) -> Result<(), String> {
    let native = state.db.get_setting("native_toasts").map(|v| v != "false").unwrap_or(true);

    let mut events = evaluate_preflight(&state.db, now)?;
    events.extend(evaluate_due(&state.db, now, state.started_at, GRACE_SECONDS)?);

    for ev in events {
        let _ = app.emit("app://alarm", ev.clone());
        if !native {
            continue;
        }
        let title = match ev.kind.as_str() {
            "missed" => format!("Missed alarm - {}", ev.label),
            "preflight" => format!("Heads-up - {}", ev.label),
            _ => format!("Alarm - {}", ev.label),
        };
        let body = match (&ev.task_title, ev.kind.as_str()) {
            (Some(t), "missed") => format!("Passed while you were away. Linked task: {t}"),
            (Some(t), "preflight") => format!("{t} is due soon"),
            (Some(t), _) => format!("Linked task: {t}"),
            (None, "missed") => "It was due while DJ Task Manager was closed.".to_string(),
            (None, _) => "Open DJ Task Manager to snooze or dismiss.".to_string(),
        };
        // A live alarm gets the sticky, looping alarm toast; a catch-up entry is a plain
        // reminder, because demanding attention for the past is just noise.
        let sticky = ev.kind == "fired";
        crate::notify::notify(app, &title, &body, &ev.sound, ev.escalating, sticky, Some(ev.id));
    }

    let snapshot = {
        let mut done = None;
        {
            let mut t = match state.timer.lock() {
                Ok(g) => g,
                Err(_) => return Ok(()),
            };
            if t.running && !t.paused {
                t.remaining_sec -= 1;
                if t.remaining_sec <= 0 {
                    t.remaining_sec = 0;
                    t.running = false;
                    done = Some(t.label.clone());
                }
            }
        }
        let snap = state.snapshot_timer();
        if let Some(label) = done {
            if native {
                crate::notify::notify(
                    app,
                    "Focus timer finished",
                    &format!("{label} is complete."),
                    "chime",
                    false,
                    false,
                    None,
                );
            }
            let _ = app.emit("app://timer-done", label);
        }
        snap
    };
    let _ = app.emit("app://timer", snapshot);

    if ticks % 10 == 0 {
        let _ = app.emit(
            "app://tick",
            serde_json::json!({
                "now": now,
                "driftMs": state.drift_ms(),
                "ticks": ticks,
                "uptimeSec": now - state.started_at,
                "startedAt": state.started_at,
            }),
        );
    }
    Ok(())
}
