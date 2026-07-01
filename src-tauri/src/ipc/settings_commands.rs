//! Settings Tauri commands.
//!
//! Thin adapters over [`SettingsService`](crate::settings::SettingsService),
//! following the same shape as [`fs_commands`](crate::ipc::fs_commands): async
//! `#[tauri::command]` fns taking `State<'_, AppState>` and returning
//! `crate::error::Result<T>`.

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::error::Result;
use crate::ipc::state::AppState;
use crate::settings::{window, Manifest};

/// Return the full runtime config document.
#[tauri::command]
pub async fn get_all_settings(state: State<'_, AppState>) -> Result<Value> {
    Ok(state.settings.get_all())
}

/// Read a single value. When `default` is omitted the manifest default for
/// `path` is used.
#[tauri::command]
pub async fn get_setting(
    path: String,
    default: Option<Value>,
    state: State<'_, AppState>,
) -> Result<Value> {
    Ok(match default {
        Some(d) => state.settings.get::<Value>(&path, d),
        None => state.settings.get_or_default::<Value>(&path),
    })
}

/// Validate, persist, and broadcast a single value (`settings_changed`).
#[tauri::command]
pub async fn set_setting(
    path: String,
    value: Value,
    state: State<'_, AppState>,
) -> Result<()> {
    state.settings.set(&path, value)
}

/// Return a clone of the embedded manifest so the frontend can render controls.
#[tauri::command]
pub async fn get_settings_manifest(state: State<'_, AppState>) -> Result<Manifest> {
    Ok(state.settings.manifest().clone())
}

/// Open (or focus) the standalone Settings window.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<()> {
    window::open_or_focus(&app)
}
