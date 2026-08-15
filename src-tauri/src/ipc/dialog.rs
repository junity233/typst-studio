//! Native file/folder dialog helpers.
//!
//! One home for the pipeline every picker repeats: clone the app handle →
//! `spawn_blocking` (the native panel runs on the main thread while the
//! caller's worker thread waits — the webview event loop is never stalled) →
//! map the join error → convert the plugin's `FilePath` via
//! [`path_buf_from`](super::commands::path_buf_from). Callers keep only their
//! filters, default file name, and cancel semantics (`Ok(None)` for "no
//! result" flows, a `Cancelled`/`Other("…cancelled")` error where the
//! frontend expects a rejection).

use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};

use super::commands::path_buf_from;

/// A dialog filter: `(display name, extensions)`, e.g. `("Typst", &["typ"])`.
pub(crate) type DialogFilter = (&'static str, &'static [&'static str]);

/// Open a native file picker. `Ok(None)` = the user cancelled the dialog.
pub(crate) async fn pick_file(
    app: &AppHandle,
    filters: &[DialogFilter],
) -> Result<Option<PathBuf>> {
    let app = app.clone();
    let filters = filters.to_vec();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        for (name, extensions) in &filters {
            builder = builder.add_filter(*name, extensions);
        }
        builder.blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    picked.map(path_buf_from).transpose()
}

/// Open a native save dialog. `Ok(None)` = the user cancelled the dialog.
pub(crate) async fn save_file(
    app: &AppHandle,
    filters: &[DialogFilter],
    default_name: Option<&str>,
) -> Result<Option<PathBuf>> {
    let app = app.clone();
    let filters = filters.to_vec();
    let default_name = default_name.map(str::to_string);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        for (name, extensions) in &filters {
            builder = builder.add_filter(*name, extensions);
        }
        if let Some(name) = &default_name {
            builder = builder.set_file_name(name);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    picked.map(path_buf_from).transpose()
}

/// Open a native folder picker. `Ok(None)` = the user cancelled the dialog.
pub(crate) async fn pick_folder(app: &AppHandle) -> Result<Option<PathBuf>> {
    let app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    picked.map(path_buf_from).transpose()
}
