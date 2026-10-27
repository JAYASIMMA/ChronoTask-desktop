//! Windows-first notification delivery.
//!
//! Two problems had to be solved to get a real Windows toast instead of a silent,
//! unbranded one:
//!
//! 1. **Attribution.** A toast is branded by its AppUserModelID. The notification plugin
//!    only sets it when the exe is *not* under `target\debug|release`, and Windows
//!    resolves the display name and icon from a Start Menu shortcut registered under
//!    that AUMID — which the NSIS installer creates. We additionally claim the AUMID for
//!    the current process so the identity is correct even when running unpackaged.
//! 2. **Sound.** The sound name is matched case-sensitively against a small set
//!    (`Default`, `IM`, `Mail`, `Reminder`, `SMS`, or a loopable name). An unrecognised
//!    string yields a silent toast, so the profile names are mapped here rather than
//!    passed through from the UI.
//!
//! On Windows an alarm uses `Scenario::Alarm`, which is the toast that expands, stays up
//! until dismissed, and loops the alarm sound. If that path fails for any reason the call
//! falls back to the cross-platform plugin builder, so a notification is never lost.
use serde_json::json;
use tauri::{AppHandle, Emitter};

/// One place to map UI sound profiles onto OS sound identifiers.
pub fn windows_sound(profile: &str, escalating: bool) -> &'static str {
    match (profile, escalating) {
        ("silent", _) => "silent",
        (_, true) => "Alarm",
        ("bell", _) => "IM",
        ("pulse", _) => "Mail",
        // "reminder" is the toast Windows shows with a looping-capable alarm tone and it
        // is the closest match to a soft chime.
        _ => "Reminder",
    }
}

#[cfg(windows)]
mod win {
    use super::windows_sound;
    use std::ffi::c_void;

    use tauri_winrt_notification::{Duration, LoopableSound, Scenario, Sound, Toast};

    #[link(name = "shell32")]
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(id: *const u16) -> i32;
    }

    /// Claims the AUMID for this process. Safe to call more than once.
    pub fn claim_aumid(identifier: &str) {
        let wide: Vec<u16> = identifier.encode_utf16().chain(std::iter::once(0)).collect();
        // The call only touches our own process; an error just means the identity was
        // already set or the API is unavailable on this build of Windows.
        let _hr = unsafe { SetCurrentProcessExplicitAppUserModelID(wide.as_ptr() as *const c_void as *const u16) };
    }

    /// True when the exe is running from a cargo target directory, i.e. unpackaged.
    fn unpackaged() -> bool {
        let Ok(exe) = tauri::utils::platform::current_exe() else {
            return true;
        };
        let text = exe.display().to_string();
        text.ends_with(r#"\target\debug"#) || text.ends_with(r#"\target\release"#)
    }

    /// Builds and shows a native toast. Returns Err so the caller can fall back.
    pub fn show(
        identifier: &str,
        title: &str,
        body: &str,
        sound_profile: &str,
        escalating: bool,
        sticky: bool,
    ) -> Result<(), String> {
        let mut toast = Toast::new(identifier).title(title).text1(body);

        if sticky {
            // Expands, loops the alarm tone, and stays until the user acts.
            toast = toast
                .scenario(Scenario::Alarm)
                .sound(Some(Sound::Loop(LoopableSound::Alarm)));
        } else {
            toast = toast.duration(Duration::Long);
            match windows_sound(sound_profile, escalating) {
                "silent" => toast = toast.sound(None),
                "Alarm" => toast = toast.sound(Some(Sound::Single(LoopableSound::Alarm))),
                "IM" => toast = toast.sound(Some(Sound::IM)),
                "Mail" => toast = toast.sound(Some(Sound::Mail)),
                _ => toast = toast.sound(Some(Sound::Reminder)),
            }
        }

        // Buttons need an activation broker to route back into the app, which an
        // unpackaged exe does not have; adding them there yields a dead click.
        if !unpackaged() {
            toast = toast
                .add_button("Open DJ Task Manager", "open")
                .add_button("Dismiss", "dismiss");
        }

        toast.show().map_err(|e| format!("{e:?}"))
    }
}

#[cfg(not(windows))]
mod win {
    pub fn claim_aumid(_identifier: &str) {}
    pub fn show(
        _identifier: &str,
        _title: &str,
        _body: &str,
        _sound: &str,
        _escalating: bool,
        _sticky: bool,
    ) -> Result<(), String> {
        Err("native toast path is Windows-only".to_string())
    }
}

/// Delivers an alarm notification and always tells the UI about it, so the in-app banner
/// appears even when the OS refuses to show a toast.
pub fn notify(
    app: &AppHandle,
    title: &str,
    body: &str,
    sound_profile: &str,
    escalating: bool,
    sticky: bool,
    alarm_id: Option<i64>,
) {
    #[cfg(windows)]
    let native = win::show(
        &app.config().identifier,
        title,
        body,
        sound_profile,
        escalating,
        sticky,
    );
    #[cfg(not(windows))]
    let native: Result<(), String> = Err("not-windows".into());

    if let Err(e) = native {
        use tauri_plugin_notification::NotificationExt;
        let mut builder = app.notification().builder().title(title).body(body);
        builder = match windows_sound(sound_profile, escalating) {
            "silent" => builder,
            name => builder.sound(name),
        };
        if let Err(e2) = builder.show() {
            eprintln!("[dj-task-manager] notification failed twice: {e}; fallback: {e2}");
        }
    }

    // The webview renders its own banner and refreshes the catch-up log from this.
    let _ = app.emit(
        "app://notified",
        json!({ "title": title, "body": body, "alarmId": alarm_id, "at": chrono::Local::now().timestamp() }),
    );
}

/// Called once during setup so the process identity exists before any toast is built.
pub fn init_identity(app: &AppHandle) {
    win::claim_aumid(&app.config().identifier);
}
