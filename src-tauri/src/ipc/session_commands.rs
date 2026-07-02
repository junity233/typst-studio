//! Session memory commands: read/update the last-opened workspace + file.
//!
//! Thin adapters over [`SessionService`](crate::service::session::SessionService).
//! The patch payload is a free-form object (`{ lastWorkspace?, lastFile? }`);
//! only the present string fields are applied.

use serde_json::Value;
use tauri::State;

use crate::error::Result;
use crate::ipc::state::AppState;
use crate::service::session::Session;

#[tauri::command]
pub async fn get_session(state: State<'_, AppState>) -> Result<Session> {
    Ok(state.session.get())
}

#[tauri::command]
pub async fn save_session(
    patch: Value,
    state: State<'_, AppState>,
) -> Result<Session> {
    state.session.update(patch)
}
