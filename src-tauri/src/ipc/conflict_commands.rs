//! Conflict-resolution IPC commands (§5.4).
//!
//! Thin adapters backing the conflict-resolution dialog's actions. The dialog
//! is shown when a document's `conflict != "none"` and the user tries to save
//! it (the [`SaveCoordinator`](crate::service::save_coordinator::SaveCoordinator)
//! gate rejects the in-place save with `ExternalConflict`) or via a StatusBar
//! entry. The four resolution paths (§5.4):
//!
//! - `resolve_conflict_use_disk(id)` — adopt the disk version into the buffer.
//! - `resolve_conflict_overwrite(id)` — write the buffer to disk (bypasses the
//!   gate; the explicit "I know, overwrite" action).
//! - `resolve_conflict_save_as(id)` — the existing Save As flow (NOT gated;
//!   clears the conflict on the original doc).
//! - `clear_conflict(id)` — drop the flag without touching the buffer (the
//!   "Later" / discard path; in-place save STAYS blocked until a real
//!   resolution, but the dialog closes).
//!
//! `compare_conflict(id)` is NOT needed — the `Modified` conflict event already
//! carried `diskContent` on the wire, so the frontend has it without a second
//! IPC round-trip.

use tauri::State;

use crate::domain::document::DocumentId;
use crate::error::{AppError, Result};
use crate::ipc::state::AppState;

/// Resolve a conflict by adopting the DISK version (§5.4 使用磁盘版本): replace
/// the buffer with the current on-disk content, bump revision, clear dirty +
/// conflict, re-baseline the disk version. Returns the disk content that was
/// loaded so the frontend can hydrate its copy. Errors if the file is unreadable
/// (Missing / PermissionChanged) — the dialog then offers recreate / Save As.
#[tauri::command]
pub async fn resolve_conflict_use_disk(
    state: State<'_, AppState>,
    id: DocumentId,
) -> Result<String> {
    let editor = state.editor.clone();
    // The disk read is fast (small .typ files) and already synchronous in the
    // document service; run it directly. The recompile it triggers is async on
    // the worker thread.
    editor.resolve_conflict_use_disk(id)
}

/// Resolve a conflict by OVERWRITING the disk with the current buffer (§5.4 覆盖
/// 磁盘): the explicit "I know the disk changed; overwrite it" action. Runs the
/// full §5.2 atomic-save protocol via the SaveCoordinator's overwrite path,
/// which BYPASSES the conflict gate (the normal `save_file` would reject with
/// `ExternalConflict`). On success the conflict + dirty are cleared. Returns
/// nothing on success; rejects with a structured IpcError on write failure
/// (dirty stays true — §11.2).
#[tauri::command]
pub async fn resolve_conflict_overwrite(
    state: State<'_, AppState>,
    id: DocumentId,
) -> Result<()> {
    state
        .save
        .save_overwrite(id)
        .await
        .map_err(|ipc| match ipc.code {
            crate::ipc::error::ErrorCode::NotFound => AppError::NotFound(ipc.message),
            _ => AppError::Code {
                code: ipc.code,
                message: ipc.message,
                recoverable: ipc.recoverable,
                details: ipc.details,
            },
        })
}

/// Clear the conflict flag WITHOUT touching the buffer or dirty state (§5.4
/// 稍后处理 / discard). The in-place save STAYS blocked (the doc is still
/// "conflicted" from the gate's perspective once re-detected), but the dialog
/// closes and the user keeps editing. Idempotent — no-op for an unknown id.
#[tauri::command]
pub async fn clear_conflict(state: State<'_, AppState>, id: DocumentId) -> Result<()> {
    state.editor.clear_conflict(id)
}

#[cfg(test)]
mod tests {
    // The conflict commands are thin adapters over DocumentService /
    // SaveCoordinator, which are exhaustively tested in their own modules
    // (document_service.rs, save_coordinator.rs). The §11.3 acceptance cases
    // (use_disk clears dirty+conflict, overwrite clears conflict, save is
    // blocked) live there alongside the services they exercise; the IPC layer
    // adds only the Tauri command wrapping, which has no unit-testable logic
    // beyond the delegation.
}
