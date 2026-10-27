//! Tauri IPC surface. Every function here is callable from the webview as
//! `invoke('<name>', { ...args })`; all of them return `Result<T, String>` so the
//! frontend can surface real database/scheduler errors instead of failing silently.
use crate::db::{AlarmInput, Db, TaskInput};
use crate::state::{AppState, TimerState};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: &'static str,
    pub app_name: &'static str,
    pub db_path: String,
    pub data_dir: String,
    pub started_at: i64,
    pub platform: &'static str,
    pub timer: TimerState,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub ok: bool,
    pub message: String,
}

fn state(app: &AppHandle) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

// -- meta ------------------------------------------------------------------

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let s = state(&app);
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        app_name: "DJ Task Manager",
        db_path: s.db.path.to_string_lossy().to_string(),
        data_dir: s.app_dir.to_string_lossy().to_string(),
        started_at: s.started_at,
        platform: std::env::consts::OS,
        timer: s.snapshot_timer(),
    }
}

#[tauri::command]
pub fn stats(app: AppHandle) -> Result<crate::db::Stats, String> {
    state(&app).db.stats()
}

#[tauri::command]
pub fn storage_report(app: AppHandle) -> Result<serde_json::Value, String> {
    state(&app).db.storage_report()
}

// -- tasks -----------------------------------------------------------------

#[tauri::command]
pub fn list_tasks(app: AppHandle, filter: Option<String>, query: Option<String>) -> Result<Vec<crate::db::Task>, String> {
    state(&app).db.list_tasks(&filter.unwrap_or_default(), &query.unwrap_or_default())
}

#[tauri::command]
pub fn save_task(app: AppHandle, input: TaskInput) -> Result<crate::db::Task, String> {
    state(&app).db.save_task(&input)
}

#[tauri::command]
pub fn set_task_status(app: AppHandle, id: i64, status: String) -> Result<crate::db::Task, String> {
    state(&app).db.set_task_status(id, &status)
}

#[tauri::command]
pub fn delete_task(app: AppHandle, id: i64) -> Result<WriteResult, String> {
    state(&app).db.delete_task(id)?;
    Ok(WriteResult { ok: true, message: "task deleted".into() })
}

#[tauri::command]
pub fn list_subtasks(app: AppHandle, task_id: i64) -> Result<Vec<crate::db::Subtask>, String> {
    state(&app).db.list_subtasks(task_id)
}

#[tauri::command]
pub fn add_subtask(app: AppHandle, task_id: i64, title: String) -> Result<Vec<crate::db::Subtask>, String> {
    state(&app).db.add_subtask(task_id, &title)
}

#[tauri::command]
pub fn toggle_subtask(app: AppHandle, id: i64) -> Result<WriteResult, String> {
    state(&app).db.toggle_subtask(id)?;
    Ok(WriteResult { ok: true, message: "toggled".into() })
}

#[tauri::command]
pub fn delete_subtask(app: AppHandle, id: i64) -> Result<WriteResult, String> {
    state(&app).db.delete_subtask(id)?;
    Ok(WriteResult { ok: true, message: "deleted".into() })
}

/// Creates the task and, when `alarm_at` is given, an armed alarm linked to it.
#[tauri::command]
pub fn create_task_with_alarm(
    app: AppHandle,
    input: TaskInput,
    alarm_at: Option<i64>,
    alarm_label: Option<String>,
    snooze_min: Option<i64>,
) -> Result<crate::db::Task, String> {
    let s = state(&app);
    let task = s.db.save_task(&input)?;
    if let Some(at) = alarm_at {
        let label = alarm_label
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| format!("Reminder: {}", task.title));
        s.db.save_alarm(&AlarmInput {
            id: None,
            label,
            fire_at: at,
            repeat: "none".into(),
            days: vec![],
            snooze_min: snooze_min.unwrap_or(5),
            sound: "chime".into(),
            task_id: Some(task.id),
            advance_min: 0,
            max_snoozes: 0,
            escalate: false,
        })?;
    }
    s.db.task_by_id(task.id)
}

// -- alarms ----------------------------------------------------------------

#[tauri::command]
pub fn list_alarms(app: AppHandle) -> Result<Vec<crate::db::Alarm>, String> {
    state(&app).db.list_alarms()
}

#[tauri::command]
pub fn save_alarm(app: AppHandle, input: AlarmInput) -> Result<crate::db::Alarm, String> {
    state(&app).db.save_alarm(&input)
}

#[tauri::command]
pub fn set_alarm_state(app: AppHandle, id: i64, new_state: String) -> Result<crate::db::Alarm, String> {
    state(&app).db.set_alarm_state(id, &new_state)
}

#[tauri::command]
pub fn delete_alarm(app: AppHandle, id: i64) -> Result<WriteResult, String> {
    state(&app).db.delete_alarm(id)?;
    Ok(WriteResult { ok: true, message: "alarm deleted".into() })
}

#[tauri::command]
pub fn snooze_alarm(app: AppHandle, id: i64, minutes: i64) -> Result<crate::db::Alarm, String> {
    state(&app).db.snooze_alarm(id, minutes)
}

/// Delivers the toast an alarm would raise, without touching the alarm.
///
/// The earlier version rescheduled the alarm a few seconds into the future, which for a
/// recurring alarm silently rewrote its daily slot — testing should never cost you data.
#[tauri::command]
pub fn test_alarm(app: AppHandle, id: i64) -> Result<WriteResult, String> {
    let s = state(&app);
    let alarm = s.db.alarm_by_id(id)?;
    crate::notify::notify(
        &app,
        &format!("Alarm - {}", alarm.label),
        &format!(
            "Test delivery at {} ({})",
            crate::db::epoch_hhmm(alarm.fire_at),
            if alarm.next_fire_at.is_some() { "armed" } else { &alarm.state }
        ),
        &alarm.sound,
        alarm.escalate,
        true,
        Some(alarm.id),
    );
    let _ = s.db.record_alarm_event(Some(alarm.id), &alarm.label, "fired", alarm.fire_at, "manual test");
    Ok(WriteResult { ok: true, message: format!("delivered a test toast for '{}'", alarm.label) })
}

#[tauri::command]
pub fn test_notification(app: AppHandle, title: Option<String>, body: Option<String>) -> WriteResult {
    crate::notify::notify(
        &app,
        &title.unwrap_or_else(|| "DJ Task Manager".into()),
        &body.unwrap_or_else(|| "Native Windows toast delivery is working.".into()),
        "chime",
        false,
        false,
        None,
    );
    WriteResult { ok: true, message: "toast delivered (sticky alarm style)".into() }
}

// -- missed / catch-up -----------------------------------------------------

#[tauri::command]
pub fn list_missed(app: AppHandle, only_open: Option<bool>) -> Result<Vec<crate::db::MissedRow>, String> {
    state(&app).db.list_missed(only_open.unwrap_or(false))
}

#[tauri::command]
pub fn resolve_missed(app: AppHandle, id: i64, resolution: String) -> Result<WriteResult, String> {
    let s = state(&app);
    let res = match resolution.as_str() {
        "snoozed" | "dismissed" | "acknowledged" => resolution,
        other => return Err(format!("invalid resolution: {other}")),
    };
    s.db.resolve_missed(id, &res)?;
    Ok(WriteResult { ok: true, message: res })
}

#[tauri::command]
pub fn clear_missed(app: AppHandle) -> Result<WriteResult, String> {
    let n = state(&app).db.clear_missed()?;
    Ok(WriteResult { ok: true, message: format!("{n} entries cleared") })
}

/// Snoozes every still-unhandled missed alarm in one action.
#[tauri::command]
pub fn catch_up_snooze_all(app: AppHandle, minutes: i64) -> Result<WriteResult, String> {
    let s = state(&app);
    let rows = s.db.list_missed(true)?;
    let mut n = 0;
    for row in rows {
        s.db.resolve_missed(row.id, "snoozed")?;
        if let Some(aid) = row.alarm_id {
            s.db.snooze_alarm(aid, minutes)?;
        }
        n += 1;
    }
    Ok(WriteResult { ok: true, message: format!("{n} alarms snoozed +{minutes}m") })
}

// -- calendar --------------------------------------------------------------

#[tauri::command]
pub fn month_events(app: AppHandle, year: i32, month: i32) -> Result<serde_json::Value, String> {
    state(&app).db.month_events(year, month)
}

// -- settings --------------------------------------------------------------

#[tauri::command]
pub fn settings_all(app: AppHandle) -> Result<serde_json::Value, String> {
    let pairs = state(&app).db.all_settings()?;
    Ok(serde_json::Value::Object(
        pairs.into_iter().map(|(k, v)| (k, serde_json::Value::String(v))).collect(),
    ))
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String) -> Result<WriteResult, String> {
    state(&app).db.set_setting(&key, &value)?;
    Ok(WriteResult { ok: true, message: format!("{key}={value}") })
}

// -- focus timer -----------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerInput {
    pub label: String,
    pub minutes: i64,
    pub task_id: Option<i64>,
}

#[tauri::command]
pub fn timer_start(app: AppHandle, input: TimerInput) -> TimerState {
    let s = state(&app);
    let secs = input.minutes.clamp(1, 600) * 60;
    let mut t = match s.timer.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    t.running = true;
    t.paused = false;
    t.label = if input.label.trim().is_empty() { "Focus block".into() } else { input.label.trim().to_string() };
    t.task_id = input.task_id;
    t.total_sec = secs;
    t.remaining_sec = secs;
    t.clone()
}

#[tauri::command]
pub fn timer_pause(app: AppHandle) -> TimerState {
    let s = state(&app);
    {
        let mut t = match s.timer.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if t.running {
            t.paused = true;
        }
    }
    s.snapshot_timer()
}

#[tauri::command]
pub fn timer_resume(app: AppHandle) -> TimerState {
    let s = state(&app);
    {
        let mut t = match s.timer.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if t.running {
            t.paused = false;
        }
    }
    s.snapshot_timer()
}

#[tauri::command]
pub fn timer_stop(app: AppHandle) -> TimerState {
    let s = state(&app);
    {
        let mut t = match s.timer.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        t.running = false;
        t.paused = false;
        t.remaining_sec = 0;
        t.total_sec = 0;
    }
    s.snapshot_timer()
}

#[tauri::command]
pub fn timer_state(app: AppHandle) -> TimerState {
    state(&app).snapshot_timer()
}

// -- window / tray ---------------------------------------------------------

#[tauri::command]
pub fn window_hide(app: AppHandle) -> WriteResult {
    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.hide();
            WriteResult { ok: true, message: "minimised to tray".into() }
        }
        None => WriteResult { ok: false, message: "main window not found".into() },
    }
}

#[tauri::command]
pub fn window_show(app: AppHandle) -> WriteResult {
    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            WriteResult { ok: true, message: "shown".into() }
        }
        None => WriteResult { ok: false, message: "main window not found".into() },
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

// -- export / import -------------------------------------------------------

#[tauri::command]
pub async fn export_snapshot(app: AppHandle) -> Result<WriteResult, String> {
    let s = state(&app);
    let json = s.db.snapshot_json()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let picked = app
        .dialog()
        .file()
        .set_file_name(format!("djtaskmanager-backup-{stamp}.json"))
        .add_filter("DJ Task Manager snapshot", &["json"])
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(WriteResult { ok: false, message: "export cancelled".into() });
    };
    std::fs::write(&path, json).map_err(|e| format!("write failed: {e}"))?;
    Ok(WriteResult {
        ok: true,
        message: format!("wrote {}", path.display()),
    })
}

#[tauri::command]
pub async fn import_snapshot(app: AppHandle) -> Result<WriteResult, String> {
    let s = state(&app);
    let picked = app
        .dialog()
        .file()
        .add_filter("DJ Task Manager snapshot", &["json"])
        .blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(WriteResult { ok: false, message: "import cancelled".into() });
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    let rows = s.db.restore_json(&raw)?;
    Ok(WriteResult {
        ok: true,
        message: format!("restored {rows} rows from {}", path.display()),
    })
}

#[tauri::command]
pub fn vacuum(app: AppHandle) -> Result<WriteResult, String> {
    let db: Arc<Db> = state(&app).db.clone();
    {
        let c = db.conn.lock().map_err(|_| "mutex poisoned".to_string())?;
        c.execute_batch("VACUUM; ANALYZE;").map_err(|e| e.to_string())?;
    }
    Ok(WriteResult { ok: true, message: "VACUUM + ANALYZE complete".into() })
}

/// Clears all content while keeping preferences — the "start with my own data" action.
#[tauri::command]
pub fn reset_workspace(app: AppHandle) -> Result<WriteResult, String> {
    let removed = state(&app).db.reset_workspace()?;
    let total: i64 = removed.values().filter_map(|v| v.as_i64()).sum();
    Ok(WriteResult {
        ok: true,
        message: format!("cleared {total} rows; preferences kept ({})", serde_json::to_string(&removed).unwrap_or_default()),
    })
}

// -- search & analytics ----------------------------------------------------

#[tauri::command]
pub fn search_tasks(app: AppHandle, query: String, limit: Option<i64>) -> Result<Vec<crate::db::analytics::SearchHit>, String> {
    state(&app).db.search_tasks(&query, limit.unwrap_or(20))
}

#[tauri::command]
pub fn analytics(app: AppHandle, days: Option<i64>) -> Result<serde_json::Value, String> {
    state(&app).db.analytics(days.unwrap_or(14))
}

#[tauri::command]
pub fn schema_report(app: AppHandle) -> Result<serde_json::Value, String> {
    state(&app).db.schema_report()
}

#[tauri::command]
pub fn list_occurrences(app: AppHandle, limit: Option<i64>) -> Result<Vec<crate::db::Task>, String> {
    state(&app).db.list_occurrences(limit.unwrap_or(50))
}

// -- history ---------------------------------------------------------------

#[tauri::command]
pub fn list_alarm_history(
    app: AppHandle,
    alarm_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<crate::db::history::AlarmEventRow>, String> {
    state(&app).db.list_alarm_history(alarm_id, limit.unwrap_or(60))
}

#[tauri::command]
pub fn list_activity(
    app: AppHandle,
    task_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<crate::db::history::ActivityRow>, String> {
    state(&app).db.list_activity(task_id, limit.unwrap_or(60))
}

#[tauri::command]
pub fn prune_history(app: AppHandle, keep_days: Option<i64>) -> Result<WriteResult, String> {
    let days = keep_days.unwrap_or(90).max(1);
    let (h, a) = state(&app).db.prune_history(days)?;
    Ok(WriteResult { ok: true, message: format!("removed {h} alarm events and {a} activity rows older than {days}d") })
}

// -- database maintenance --------------------------------------------------

#[tauri::command]
pub fn db_integrity(app: AppHandle) -> Result<serde_json::Value, String> {
    let s = state(&app);
    let full = s.db.integrity_check()?;
    let quick = s.db.quick_check()?;
    Ok(serde_json::json!({ "integrity": full, "quick": quick, "checkedAt": chrono::Local::now().timestamp() }))
}

#[tauri::command]
pub fn db_checkpoint(app: AppHandle) -> Result<WriteResult, String> {
    let (busy, log, checkpointed) = state(&app).db.wal_checkpoint()?;
    Ok(WriteResult {
        ok: busy == 0,
        message: if busy == 0 {
            format!("WAL checkpointed ({checkpointed} of {log} frames, sidecar truncated)")
        } else {
            "checkpoint skipped: a reader still holds the WAL open".to_string()
        },
    })
}

#[tauri::command]
pub async fn backup_database(app: AppHandle) -> Result<WriteResult, String> {
    let s = state(&app);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let picked = app
        .dialog()
        .file()
        .set_file_name(format!("djtaskmanager-{stamp}.db"))
        .add_filter("SQLite database", &["db"])
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(WriteResult { ok: false, message: "backup cancelled".into() });
    };
    let bytes = s.db.backup_to(&path)?;
    Ok(WriteResult {
        ok: true,
        message: format!("{} ({} KiB)", path.display(), bytes / 1024),
    })
}

#[tauri::command]
pub async fn export_csv(app: AppHandle, table: String) -> Result<WriteResult, String> {
    let s = state(&app);
    let csv = s.db.export_csv(&table)?;
    let picked = app
        .dialog()
        .file()
        .set_file_name(format!("djtaskmanager-{table}.csv"))
        .add_filter("CSV", &["csv"])
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(WriteResult { ok: false, message: "export cancelled".into() });
    };
    // Excel on Windows needs the BOM to read UTF-8 correctly.
    std::fs::write(&path, format!("\u{feff}{csv}")).map_err(|e| format!("write failed: {e}"))?;
    Ok(WriteResult { ok: true, message: format!("{} rows exported to {}", csv.lines().count().saturating_sub(1), path.display()) })
}

// -- background operation --------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartInfo {
    /// The user's stored preference — the value the switch reflects.
    pub enabled: bool,
    /// What the launch-registry entry itself claims. Only used to warn when the two
    /// disagree, never to drive the switch: the underlying check compares the stored
    /// command line against the current one, so launching with an extra flag makes it
    /// report `false` for an entry that is genuinely there.
    pub registered: bool,
    /// Whether the app is running from an installed location. Windows only brands a
    /// toast when a Start Menu shortcut registers the AppUserModelID, which the NSIS
    /// installer creates — so this tells the UI whether to promise branded alerts.
    pub installed: bool,
    pub exe_path: String,
}

fn looks_installed() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let text = exe.display().to_string();
    let sep = std::path::MAIN_SEPARATOR;
    let dev = |tail: &str| text.ends_with(&format!("target{sep}{tail}"));
    !(dev("debug") || dev("release"))
}

/// The stored launch-at-sign-in preference. Absent means on, because a fresh install
/// that never schedules itself is an alarm manager that silently stops working.
pub fn autostart_wanted(db: &crate::db::Db) -> bool {
    db.get_setting("autostart")
        .map(|v| v != "false")
        .unwrap_or(true)
}

#[tauri::command]
pub fn autostart_state(app: AppHandle) -> Result<AutostartInfo, String> {
    let st = state(&app);
    let enabled = autostart_wanted(&st.db);
    let registered = app.autolaunch().is_enabled().unwrap_or(false);
    Ok(AutostartInfo {
        enabled,
        registered,
        installed: looks_installed(),
        exe_path: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
    })
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<AutostartInfo, String> {
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?;
    }
    state(&app).db.set_setting("autostart", if enabled { "true" } else { "false" })?;
    autostart_state(app)
}

#[tauri::command]
pub fn install_state(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "installed": looks_installed(),
        "identifier": app.config().identifier.clone(),
        "productName": app.config().product_name.clone().unwrap_or_default(),
        "version": app.package_info().version.to_string(),
    })
}
