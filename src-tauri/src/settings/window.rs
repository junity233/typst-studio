//! The standalone Settings window.
//!
//! Loads `index.html?window=settings`; the frontend's `main.tsx` branches on
//! the `?window=settings` query param to render `<SettingsApp/>`. Re-opening is
//! idempotent: if a `settings` window already exists it is focused instead of
//! recreated.

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, WebviewUrl};

use crate::error::{AppError, Result};

/// Open the Settings window, or focus it if already open.
///
/// `tauri::Error` (focus/build failures) is mapped to `AppError::Other` to
/// match the ad-hoc-error pattern used elsewhere in the IPC layer.
pub fn open_or_focus(app: &AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window("settings") {
        win.set_focus()
            .map_err(|e| AppError::Other(e.to_string()))?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Settings")
    .inner_size(760.0, 520.0)
    .resizable(true)
    .build()
    .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}
