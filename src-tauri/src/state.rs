//! Shared application state: the SQLite handle, the focus timer, and scheduler telemetry.
use crate::db::Db;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerState {
    pub running: bool,
    pub paused: bool,
    pub label: String,
    pub task_id: Option<i64>,
    pub total_sec: i64,
    pub remaining_sec: i64,
}

pub struct AppState {
    pub db: Arc<Db>,
    pub app_dir: PathBuf,
    pub started_at: i64,
    pub timer: Mutex<TimerState>,
    /// Worst observed scheduler lateness in the last window, in milliseconds.
    pub drift_ms: AtomicI64,
    pub ticks: AtomicI64,
}

impl AppState {
    pub fn new(db: Arc<Db>, app_dir: PathBuf) -> AppState {
        AppState {
            db,
            app_dir,
            started_at: chrono::Local::now().timestamp(),
            timer: Mutex::new(TimerState {
                running: false,
                paused: false,
                label: String::new(),
                task_id: None,
                total_sec: 0,
                remaining_sec: 0,
            }),
            drift_ms: AtomicI64::new(0),
            ticks: AtomicI64::new(0),
        }
    }

    pub fn snapshot_timer(&self) -> TimerState {
        self.timer.lock().map(|t| t.clone()).unwrap_or_else(|_| TimerState {
            running: false,
            paused: false,
            label: String::new(),
            task_id: None,
            total_sec: 0,
            remaining_sec: 0,
        })
    }

    pub fn record_drift(&self, ms: i64) {
        // Keep the larger magnitude so the footer shows a realistic worst case.
        let prev = self.drift_ms.load(Ordering::Relaxed);
        if ms.abs() > prev.abs() {
            self.drift_ms.store(ms, Ordering::Relaxed);
        }
    }

    pub fn drift_ms(&self) -> i64 {
        self.drift_ms.load(Ordering::Relaxed)
    }
}
