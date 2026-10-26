//! ChronoTask — desktop task & alarm manager.
//! Rust owns persistence (SQLite), the alarm scheduler thread, and native toasts;
//! the WebView window renders the UI and talks to it over `invoke`.
mod commands;
pub mod db;
pub mod scheduler;
pub mod state;

use crate::db::Db;
use crate::state::AppState;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let db = Db::open(&data_dir).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            let state = Arc::new(AppState::new(Arc::new(db), data_dir));
            app.manage(state.clone());

            build_tray(app.handle())?;
            scheduler::spawn(app.handle().clone(), state.clone());

            // Tell the UI the scheduler is live as soon as the webview is ready.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(900));
                let _ = handle.emit("app://ready", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let keep = window
                    .app_handle()
                    .state::<Arc<AppState>>()
                    .db
                    .get_setting("close_to_tray")
                    .map(|v| v != "false")
                    .unwrap_or(true);
                if keep && window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window
                        .app_handle()
                        .notification()
                        .builder()
                        .title("ChronoTask still running")
                        .body("Alarms keep firing from the tray. Quit from the tray menu to stop them.")
                        .show();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::stats,
            commands::storage_report,
            commands::list_tasks,
            commands::save_task,
            commands::create_task_with_alarm,
            commands::set_task_status,
            commands::delete_task,
            commands::list_subtasks,
            commands::add_subtask,
            commands::toggle_subtask,
            commands::delete_subtask,
            commands::list_alarms,
            commands::save_alarm,
            commands::set_alarm_state,
            commands::delete_alarm,
            commands::snooze_alarm,
            commands::test_alarm,
            commands::test_notification,
            commands::list_missed,
            commands::resolve_missed,
            commands::clear_missed,
            commands::catch_up_snooze_all,
            commands::month_events,
            commands::settings_all,
            commands::set_setting,
            commands::timer_start,
            commands::timer_pause,
            commands::timer_resume,
            commands::timer_stop,
            commands::timer_state,
            commands::window_hide,
            commands::window_show,
            commands::app_quit,
            commands::export_snapshot,
            commands::import_snapshot,
            commands::vacuum,
            commands::reset_workspace,
            commands::search_tasks,
            commands::analytics,
            commands::schema_report,
            commands::list_occurrences,
            commands::list_alarm_history,
            commands::list_activity,
            commands::prune_history,
            commands::db_integrity,
            commands::db_checkpoint,
            commands::backup_database,
            commands::export_csv,
        ])
        .run(tauri::generate_context!())
        .expect("ChronoTask failed to start");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "Open ChronoTask", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", "Hide Window", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit (stops alarms)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &sep, &quit])?;

    let icon = app.default_window_icon().cloned();

    let mut builder = TrayIconBuilder::with_id("chronotask-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("ChronoTask — scheduler active")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "tray-hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
