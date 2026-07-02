//! The standalone Settings window.
//!
//! Loads `index.html?window=settings`; the frontend's `main.tsx` branches on
//! the `?window=settings` query param to render `<SettingsApp/>`. Re-opening is
//! idempotent: if a `settings` window already exists it is focused instead of
//! recreated.
//!
//! The window is `always_on_top` so it floats above the main window, and the
//! main window renders a modal overlay while it is open (Tauri has no
//! cross-platform native modal). The backend broadcasts `settings_window`
//! `{ open }` on create/destroy so every window can track visibility.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter as _, Manager, WebviewUrl, webview::WebviewWindowBuilder, WindowEvent};

use crate::error::{AppError, Result};

/// Payload for the `settings_window` visibility broadcast.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SettingsWindowPayload {
    pub open: bool,
}

/// Open the Settings window, or focus it if already open.
///
/// `tauri::Error` (focus/build failures) is mapped to `AppError::Other` to
/// match the ad-hoc-error pattern used elsewhere in the IPC layer.
pub fn open_or_focus(app: &AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window("settings") {
        win.set_focus()
            .map_err(|e| AppError::Other(e.to_string()))?;
        // Re-announce so a window that missed the initial broadcast converges.
        let _ = app.emit("settings_window", SettingsWindowPayload { open: true });
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Settings")
    .inner_size(760.0, 520.0)
    .resizable(true)
    .always_on_top(true)
    .build()
    .map_err(|e| AppError::Other(e.to_string()))?;

    // Announce open, then watch for close so the main window can drop its
    // modal overlay. `Destroyed` fires after any closeRequested and is the
    // reliable "it's gone" signal.
    let _ = app.emit("settings_window", SettingsWindowPayload { open: true });
    let app_for_close = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = app_for_close.emit(
                "settings_window",
                SettingsWindowPayload { open: false },
            );
        }
    });
    Ok(())
}
