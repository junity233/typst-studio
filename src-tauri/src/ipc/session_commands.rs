//! Session memory commands: read/update the persisted session, plus a
//! session-restore helper that re-marks a restored document dirty (§13).
//!
//! Thin adapters over [`SessionService`](crate::service::session::SessionService)
//! and [`EditorService`](crate::service::editor_service::EditorService). The
//! `save_session` patch payload is a free-form object; only the present fields
//! are applied (see [`SessionService::update`] for tolerance behavior).

use serde_json::Value;
use tauri::State;

use crate::domain::document::DocumentId;
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

/// Set a tab's dirty flag (§13). Used by the session-restore path to re-mark a
/// restored document dirty when it was dirty at shutdown. No-op if the tab is
/// not open.
#[tauri::command]
pub async fn set_dirty(
    state: State<'_, AppState>,
    id: DocumentId,
    dirty: bool,
) -> Result<()> {
    state.editor.set_dirty(id, dirty);
    Ok(())
}
