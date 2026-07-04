//! Workspace / filesystem Tauri commands.
//!
//! These wire the frontend's file-tree and Save As needs to
//! [`WorkspaceService`](crate::service::workspace_service::WorkspaceService) and
//! [`EditorService`](crate::service::editor_service::EditorService). They are
//! thin adapters: argument conversion + delegating to the service layer, with
//! blocking IO offloaded via `spawn_blocking` (same pattern as `commands.rs`).

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter as _, State};
use tauri_plugin_dialog::DialogExt;

use crate::domain::document::DocumentId;
use crate::error::{AppError, Result};
use crate::fs::tree::EntryKind;
use crate::fs::watcher;
use crate::ipc::events::{FsChangedPayload, OpenedDocument};
use crate::ipc::state::AppState;
use crate::service::workspace_service::WorkspaceMeta;

/// Wire view of one document rebound by a rename/move (§6.4). Emitted in the
/// `docs_rebound` event payload AND returned from the `rename_entry` command so
/// the frontend can rebind tab titles / breadcrumbs / active-file highlight.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ReboundDoc {
    pub id: DocumentId,
    /// The pre-rename canonical path.
    pub old_path: String,
    /// The post-rename canonical path.
    pub new_path: String,
}

/// Payload of the `docs_rebound` event (§6.4): the docs rebound by a single
/// rename/move, so the frontend updates their tab title / breadcrumb / active
/// highlight in one batch.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DocsReboundPayload {
    pub docs: Vec<ReboundDoc>,
}

/// Wire view of one open document that blocked a delete (§5.5). Carried in the
/// `DeleteBlocked` error's `details.affectedDocs` so the frontend can name the
/// docs the user must save/close first.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct AffectedDoc {
    pub id: DocumentId,
    pub path: String,
}

/// Result of a `delete_entry` command (§5.5): `"trashed"` (the default) or
/// `"permanently_deleted"` (the explicit advanced action). Surfaced so the
/// frontend can show the right confirmation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DeleteResult {
    pub outcome: String,
}

/// Open `root` as the workspace (set root + resolver, start the watcher). Shared
/// by the dialog picker and the default-workspace (cwd) opener. Builds the
/// `fs_changed` emitter callback. After a successful open, asks the editor
/// service to reclassify already-open documents so those inside the new root
/// switch from `LooseFile` to `WorkspaceFile` (§4.3).
fn open_path_as_workspace(
    app: &AppHandle,
    state: &AppState,
    root: PathBuf,
) -> Result<WorkspaceMeta> {
    // The watcher callback needs two things: the AppHandle (to emit `fs_changed`
    // for the frontend's tree refresh) and an Arc<EditorService> (to route
    // document paths into conflict/reload handling, §8.4). Both are cloned out
    // here because the closure must be 'static + Send + Sync — a State<'_> is
    // neither. The Arc clones are cheap and keep the services alive for the
    // watcher's lifetime.
    let app_for_cb = app.clone();
    let editor_for_cb = state.editor.clone();
    let on_change: watcher::OnChange = Arc::new(move |paths: &[PathBuf]| {
        // §8.4: route each changed path to the editor so an open document whose
        // backing file changed is reloaded (clean buffer) or marked conflict
        // (dirty buffer / deleted). Safe on the watcher flush thread.
        for p in paths {
            editor_for_cb.handle_external_change(p);
        }
        // Notify the frontend to refresh its file tree (independent of the
        // document-handling above — the tree shows all files, not just docs).
        let payload = FsChangedPayload {
            paths: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        };
        let _ = app_for_cb.emit("fs_changed", payload);
    });
    let meta = state.workspace.open(root, on_change)?;
    // §6.3: reflect watcher health. `watcher_healthy()` is true iff the watcher
    // guard is live (started OK); a start failure leaves it false. Surface that
    // to the watcher-health service so the frontend can warn "external detection
    // unavailable" — the polling fallback still runs as compensation.
    if state.workspace.watcher_healthy() {
        state.watcher_health.clear_watcher_failed();
    } else {
        tracing::warn!(
            "workspace opened but the filesystem watcher failed to start; \
             polling fallback will compensate (§6.3)"
        );
        state.watcher_health.mark_watcher_failed();
    }
    // Reclassify now-open documents against the new workspace. The editor and
    // workspace services are siblings (both in `AppState`); the workspace
    // service doesn't own open tabs, so this is the right place to bridge them
    // (§6.2).
    state.editor.reclassify_documents(&state.workspace);
    Ok(meta)
}

/// A native folder pick → open it as the workspace. Returns the workspace
/// metadata, or `None` if the user cancelled the dialog.
#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<WorkspaceMeta>> {
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let root = picked
        .into_path()
        .map_err(|e| AppError::InvalidInput(format!("invalid folder path: {e}")))?;

    let meta = open_path_as_workspace(&app, &state, root)?;
    Ok(Some(meta))
}

/// Open the process's current working directory as the workspace — the default
/// workspace when the user hasn't picked a folder. Used at startup so the
/// explorer shows the project the app was launched from. Returns `None` if the
/// cwd can't be determined.
#[tauri::command]
pub async fn open_default_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<WorkspaceMeta>> {
    let cwd = std::env::current_dir()
        .map_err(|e| AppError::Io(e))?;
    if !cwd.is_dir() {
        return Ok(None);
    }
    let meta = open_path_as_workspace(&app, &state, cwd)?;
    Ok(Some(meta))
}

/// Open `path` as the workspace without a dialog (used to restore the last
/// workspace on startup). Returns `None` if the path doesn't exist or isn't a
/// directory, so the caller can fall back to the default workspace.
#[tauri::command]
pub async fn open_workspace_by_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<WorkspaceMeta>> {
    let root = PathBuf::from(&path);
    if !root.is_absolute() || !root.is_dir() {
        return Ok(None);
    }
    let meta = open_path_as_workspace(&app, &state, root)?;
    Ok(Some(meta))
}

/// Close the current workspace (stops the watcher; open tabs are untouched).
/// Asks the editor service to reclassify already-open documents so former
/// `WorkspaceFile`s demote to `LooseFile` (rooted at their parent dir, so
/// same-dir `#include` still resolves) (§4.3).
#[tauri::command]
pub async fn close_workspace(state: State<'_, AppState>) -> Result<()> {
    state.workspace.close();
    state.editor.reclassify_documents(&state.workspace);
    Ok(())
}

/// Query the current workspace metadata, or `None` if no folder is open.
#[tauri::command]
pub async fn get_workspace(state: State<'_, AppState>) -> Result<Option<WorkspaceMeta>> {
    let ws = state.workspace.clone();
    Ok(ws.root().map(|root| {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        WorkspaceMeta {
            root: root.display().to_string(),
            name,
        }
    }))
}

/// §6.3: whether the filesystem watcher failed to start. The frontend surfaces
/// a non-modal "external change detection unavailable" warning when true. The
/// polling fallback runs regardless (compensating for the failed watcher), so
/// this is purely a UI affordance — not a capability gate.
#[tauri::command]
pub async fn get_watcher_health(state: State<'_, AppState>) -> Result<WatcherHealthPayload> {
    Ok(WatcherHealthPayload {
        watcher_failed: state.watcher_health.watcher_failed(),
    })
}

/// Wire payload for [`get_watcher_health`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct WatcherHealthPayload {
    /// True when the workspace watcher failed to start (the polling fallback
    /// is active as compensation).
    pub watcher_failed: bool,
}

/// List the immediate children of a workspace-relative directory ("" = root).
#[tauri::command]
pub async fn read_dir(
    state: State<'_, AppState>,
    rel: Option<String>,
) -> Result<Vec<crate::fs::tree::DirEntry>> {
    let ws = state.workspace.clone();
    ws.read_dir(rel.as_deref().unwrap_or(""))
}

/// Create a file or directory at a workspace-relative path.
#[tauri::command]
pub async fn create_entry(
    state: State<'_, AppState>,
    rel: String,
    kind: EntryKind,
) -> Result<()> {
    let ws = state.workspace.clone();
    ws.create_entry(&rel, kind)
}

/// Rename/move a workspace-relative entry to another workspace-relative path.
///
/// §6.4 联动: after the disk rename succeeds, every open document whose
/// canonical path equals or sits under `from` is rebound to the matching path
/// under `to` (registry, world/resolver, VFS, watcher, disk-version — all via
/// [`DocumentService::rebind_for_rename`]). The rebound docs are emitted as a
/// `docs_rebound` event so the frontend updates tab titles / breadcrumbs /
/// active-file highlight. Returns the list so a future caller (or test) can
/// also react without parsing the event.
#[tauri::command]
pub async fn rename_entry(
    state: State<'_, AppState>,
    app: AppHandle,
    from: String,
    to: String,
) -> Result<Vec<ReboundDoc>> {
    let ws = state.workspace.clone();
    // 1. Disk rename first. On failure, nothing below runs (§6.4 "文件操作
    //    失败时 registry、UI 和磁盘保持一致" — the disk op is the gate).
    ws.rename_entry(&from, &to)?;
    // 2. Coordinate open docs. The disk already moved; rebind each affected
    //    open doc to its new canonical path. A rebind failure (registry
    //    conflict at the new path) is logged and that doc is left at its old
    //    (now-vanished) path → the watcher will surface Missing (§6.4 recoverable).
    let from_abs = ws.resolve_path(&from)?;
    let to_abs = ws.resolve_path(&to)?;
    let rebound = state.editor.document().rebind_for_rename(&from_abs, &to_abs);
    // `rebind_path` classifies the rebound docs as `LooseFile` (parent-rooted).
    // For a rename that KEEPS the doc inside the workspace, reclassify so it
    // gets the workspace resolver back (preserving workspace-scoped `#include`
    // resolution — e.g. `#include "../shared/header.typ"` from a subdir). A
    // no-op for docs whose origin is already correct. §6.4 "resolver /
    // ResolutionContext" must follow the file.
    state.editor.reclassify_documents(&ws);
    let wire: Vec<ReboundDoc> = rebound
        .iter()
        .map(|r| ReboundDoc {
            id: r.id,
            old_path: r.old_path.to_string_lossy().into_owned(),
            new_path: r.new_path.to_string_lossy().into_owned(),
        })
        .collect();
    // 3. Emit a per-rename batch event so the frontend rebinds tab titles /
    //    breadcrumbs / active-file highlight for every affected doc in one shot.
    if !wire.is_empty() {
        let _ = app.emit("docs_rebound", DocsReboundPayload { docs: wire.clone() });
    }
    // 4. Notify the frontend to refresh its file tree (the moved entry's old
    //    and new parent dirs). The store's renameEntry already does this, but
    //    emit defensively in case a future caller bypasses the store.
    Ok(wire)
}

/// Delete a workspace-relative file or directory via the system trash (§5.5).
///
/// §5.5 dirty-delete protection: BEFORE trashing, scan the open-document
/// registry for any doc whose canonical path is AT or UNDER the delete target.
/// If ANY is dirty, the delete is REJECTED with `ErrorCode::DeleteBlocked`
/// (carrying the affected doc ids + paths in `details`) — the frontend tells
/// the user to save/close/discard those docs first. Clean open docs do NOT
/// block (they'll get `ConflictState::Missing` via the watcher once the file is
/// trashed, which is the correct recoverable state).
#[tauri::command]
pub async fn delete_entry(state: State<'_, AppState>, rel: String) -> Result<DeleteResult> {
    let ws = state.workspace.clone();
    let target = ws.resolve_path(&rel)?;
    // §5.5 dirty-doc check. The IPC layer has AppState (both workspace + editor
    // services), so this is the right place — WorkspaceService is disk-only.
    let affected = state.editor.document().docs_under_path(&target);
    let dirty: Vec<&crate::service::document_service::AffectedDoc> =
        affected.iter().filter(|d| d.dirty).collect();
    if !dirty.is_empty() {
        let affected_wire: Vec<AffectedDoc> = dirty
            .iter()
            .map(|d| AffectedDoc {
                id: d.id,
                path: d.path.to_string_lossy().into_owned(),
            })
            .collect();
        let n = affected_wire.len();
        let details = serde_json::json!({ "affectedDocs": affected_wire });
        return Err(AppError::Code {
            code: crate::ipc::error::ErrorCode::DeleteBlocked,
            message: format!(
                "{n} unsaved document(s) open under '{rel}'; save, close, or discard them before deleting."
            ),
            recoverable: true,
            details: Some(details),
        });
    }
    // No dirty docs: proceed to trash. Clean open docs under the target will be
    // marked Missing by the watcher (§8.4) — the correct recoverable state.
    let outcome = ws.delete_entry(&rel)?;
    Ok(DeleteResult {
        outcome: match outcome {
            crate::service::trash::TrashOutcome::Trashed => "trashed",
            crate::service::trash::TrashOutcome::PermanentlyDeleted => "permanently_deleted",
        }
        .to_string(),
    })
}

/// Reveal a workspace-relative file or directory in the OS file manager
/// (Finder on macOS). Uses the `tauri-plugin-opener` `reveal_item_in_dir`
/// API, which handles both files and directories correctly.
#[tauri::command]
pub async fn reveal_in_finder(
    app: AppHandle,
    state: State<'_, AppState>,
    rel: String,
) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let ws = state.workspace.clone();
    let abs = ws.resolve_path(&rel)?;
    app.opener()
        .reveal_item_in_dir(abs)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Open a file by its absolute path (no dialog) as a tab — used when clicking a
/// `.typ` entry in the file tree. The editor service derives the world's
/// resolver from the document's origin: a loose file (outside any workspace)
/// gets a parent-directory-rooted resolver so same-dir `#include` /
/// `#image()` resolve; a workspace file would get the workspace resolver
/// (plumbed in Task B).
#[tauri::command]
pub async fn open_file_by_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenedDocument> {
    let path = PathBuf::from(path);
    let path_for_read = path.clone();
    // Read on a blocking thread.
    let content = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path_for_read)
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;

    // The editor service classifies the file (loose vs workspace) and builds a
    // resolver-anchored world accordingly. A workspace file gets the workspace
    // resolver; a loose file gets the parent-rooted one.
    let editor = state.editor.clone();
    let meta = editor.open_from_disk(path, content.clone(), Some(&state.workspace))?;
    Ok(OpenedDocument { meta, content })
}

/// Save As: write a tab's text to a new file chosen via a save dialog, then
/// make the tab file-backed at that path. Used for untitled tabs (and to save a
/// file elsewhere). Returns the new path.
///
/// §5.3: the dialog stays in the IPC layer (it needs the AppHandle), but the
/// atomic write + rebind go through the [`SaveCoordinator`](crate::service::save_coordinator::SaveCoordinator)
/// so the §5.2 protocol — including "don't rebind path/registry/resolver/watcher
/// before the replace succeeds" (§11.2) — is centralized. A user-cancelled
/// dialog surfaces as `ErrorCode::Cancelled` (§5.3: not a failure).
#[tauri::command]
pub async fn save_as(
    app: AppHandle,
    state: State<'_, AppState>,
    id: crate::domain::document::DocumentId,
) -> Result<String> {
    let editor = state.editor.clone();
    let text = editor.tab_text(id).ok_or_else(|| {
        AppError::NotFound(format!("tab {id} not found"))
    })?;
    // Default the save dialog to the tab's current name (or "Untitled").
    let default_name = editor
        .tab_meta(id)
        .and_then(|m| {
            m.path
                .as_ref()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
        .unwrap_or_else(|| "Untitled.typ".to_string());

    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("Typst", &["typ"])
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else {
        // §5.3: a cancelled dialog is surfaced as the Cancelled code (not a
        // generic Other). The frontend no-ops on this.
        return Err(AppError::Code {
            code: crate::ipc::error::ErrorCode::Cancelled,
            message: "save cancelled".into(),
            recoverable: false,
            details: None,
        });
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::InvalidInput(format!("invalid file path: {e}")))?;
    // Delegate the atomic write + rebind to the SaveCoordinator (§5.2 / §11.2:
    // rebind only after the replace succeeds).
    state
        .save
        .save_as(id, path.clone(), text)
        .await
        .map_err(|ipc| match ipc.code {
            crate::ipc::error::ErrorCode::NotFound => AppError::NotFound(ipc.message),
            _ => AppError::Code {
                code: ipc.code,
                message: ipc.message,
                recoverable: ipc.recoverable,
                details: ipc.details,
            },
        })?;
    Ok(path.to_string_lossy().into_owned())
}
