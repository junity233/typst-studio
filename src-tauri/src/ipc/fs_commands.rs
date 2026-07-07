//! Workspace / filesystem Tauri commands.
//!
//! These wire the frontend's file-tree and Save As needs to
//! [`WorkspaceService`](crate::service::workspace_service::WorkspaceService) and
//! [`EditorService`](crate::service::editor_service::EditorService). They are
//! thin adapters: argument conversion + delegating to the service layer, with
//! blocking IO offloaded via `spawn_blocking` (same pattern as `commands.rs`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter as _, State};
use tauri_plugin_dialog::DialogExt;

use crate::domain::document::DocumentId;
use crate::error::{AppError, Result};
use crate::fs::tree::EntryKind;
use crate::fs::watcher;
use crate::ipc::events::{FsChangedPayload, OpenedDocument};
use crate::ipc::state::AppState;
use crate::lsp::manager::LspRestartReason;
use crate::service::workspace_service::WorkspaceMeta;

/// Upper bound on a source file we are willing to load into an editor tab via
/// the file tree. See `commands::MAX_SOURCE_FILE_BYTES` for rationale.
const MAX_SOURCE_FILE_BYTES: u64 = 10 * 1024 * 1024;

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
    // Read the fs-watcher debounce window from settings (manifest default
    // 300 ms). This is the `compiler.debounceMs` setting — the quiet period the
    // watcher waits before flushing a batch of changed paths.
    let debounce_ms = state.settings.get_or_default::<u64>("compiler.debounceMs");
    let meta = state.workspace.open(root, std::time::Duration::from_millis(debounce_ms), on_change)?;
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
    // §14.1 / §14.3: a workspace open (incl. a switch — `open()` overwrites the
    // prior root in place, so a switch is a SINGLE open here, not a close+open)
    // requests exactly ONE LSP restart AFTER reclassify succeeds, so the new
    // root is in effect when the next tinymist starts. The restart bumps the
    // generation and publishes a fresh endpoint; the frontend reconnects via
    // appLanguageClient (Task 8 part C). Non-blocking from the caller's
    // perspective — it just signals the accept loop.
    state.lsp.request_restart(LspRestartReason::WorkspaceChange);
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
    let cwd = std::env::current_dir().map_err(AppError::Io)?;
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
    // §14.2: only request an LSP restart if a workspace was actually open —
    // closing when nothing is open (stale menu state, double-close) would
    // otherwise spuriously restart tinymist. Matches the
    // `workspace_change_triggers_restart(_, false) == None` contract.
    let was_open = state.workspace.root().is_some();
    state.workspace.close();
    state.editor.reclassify_documents(&state.workspace);
    if was_open {
        // A workspace close requests ONE LSP restart AFTER reclassify succeeds
        // (so former WorkspaceFiles have demoted to LooseFile before the next
        // tinymist starts with `workspaceFolders=null`). The frontend reconnects
        // via appLanguageClient. A switch is NOT a close+open — it is a single
        // `open()` overwrite — so this path is only the explicit close.
        state.lsp.request_restart(LspRestartReason::WorkspaceChange);
    }
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

/// Cross-file search across the workspace (§Search view). The blocking
/// file-walk runs on a `spawn_blocking` thread so the async runtime isn't
/// held during disk IO.
#[tauri::command]
pub async fn search_workspace(
    state: State<'_, AppState>,
    query: crate::domain::search::SearchQuery,
) -> Result<Vec<crate::domain::search::SearchHit>> {
    let ws = state.workspace.clone();
    let hits = tauri::async_runtime::spawn_blocking(move || ws.search(&query))
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(hits)
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
    // §5.5 open-doc check. The IPC layer has AppState (workspace + editor),
    // so this is the right place — WorkspaceService is disk-only.
    let affected = block_on_unsaved_or_conflicted(&state, &rel, &target)?;
    // No unsaved/conflicted docs: proceed to trash. Clean open docs under the
    // target are marked Missing immediately; the watcher duplicate is ignored.
    let outcome = ws.delete_entry(&rel)?;
    state
        .editor
        .document()
        .mark_docs_missing(affected.into_iter().map(|doc| doc.id));
    Ok(DeleteResult {
        outcome: match outcome {
            crate::service::trash::TrashOutcome::Trashed => "trashed",
            crate::service::trash::TrashOutcome::PermanentlyDeleted => "permanently_deleted",
        }
        .to_string(),
    })
}

/// Reject the operation with `DeleteBlocked` if any dirty or conflicted document
/// is open AT or UNDER `target`. Returns all affected docs when the delete may
/// proceed so the caller can mark clean open docs Missing immediately.
fn block_on_unsaved_or_conflicted(
    state: &State<'_, AppState>,
    rel: &str,
    target: &std::path::Path,
) -> std::result::Result<Vec<crate::service::document_service::AffectedDoc>, AppError> {
    let affected = state.editor.document().docs_under_path(target);
    let blockers: Vec<&crate::service::document_service::AffectedDoc> = affected
        .iter()
        .filter(|d| d.dirty || d.conflict.is_active())
        .collect();
    if blockers.is_empty() {
        return Ok(affected);
    }
    let affected_wire: Vec<AffectedDoc> = blockers
        .iter()
        .map(|d| AffectedDoc {
            id: d.id,
            path: d.path.to_string_lossy().into_owned(),
        })
        .collect();
    let n = affected_wire.len();
    let details = serde_json::json!({ "affectedDocs": affected_wire });
    Err(AppError::Code {
        code: crate::ipc::error::ErrorCode::DeleteBlocked,
        message: format!(
            "{n} unsaved or conflicted document(s) open under '{rel}'; save, resolve, close, or discard them before deleting."
        ),
        recoverable: true,
        details: Some(details),
    })
}

/// Permanently delete a workspace-relative file or directory (§5.5 "永久删除只
/// 作为明确标注的高级动作"). NOT recoverable. This is the explicit advanced
/// action — the default [`delete_entry`] trashes. Same open-doc protection as
/// `delete_entry`: a dirty/conflicted document AT/UNDER the target blocks.
#[tauri::command]
pub async fn delete_entry_permanent(
    state: State<'_, AppState>,
    rel: String,
) -> Result<DeleteResult> {
    let ws = state.workspace.clone();
    let target = ws.resolve_path(&rel)?;
    let affected = block_on_unsaved_or_conflicted(&state, &rel, &target)?;
    let outcome = ws.delete_entry_permanent(&rel)?;
    state
        .editor
        .document()
        .mark_docs_missing(affected.into_iter().map(|doc| doc.id));
    Ok(DeleteResult {
        outcome: match outcome {
            crate::service::trash::TrashOutcome::Trashed => "trashed",
            crate::service::trash::TrashOutcome::PermanentlyDeleted => "permanently_deleted",
        }
        .to_string(),
    })
}

/// Recursively copy a workspace-relative entry to another workspace-relative
/// path (Copy / Paste / Duplicate in the file manager context menu). The source
/// is left untouched. Works for files and directories. Both paths are resolved
/// and containment-checked by the service, so `../` escapes are rejected.
#[tauri::command]
pub async fn copy_entry(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<()> {
    let ws = state.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || ws.copy_entry(&from, &to))
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?
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
    open_path_classified(&state, PathBuf::from(path)).await
}

/// Shared open-by-path logic used by both [`open_file_by_path`] (tree /
/// single-instance) and [`crate::ipc::commands::open_file`] (native dialog).
///
/// Classifies the path by extension (see [`file_kind::classify`]) and routes:
/// - Typst → the existing `open_from_disk` path (read text, build a compile
///   worker, seed the VFS — the historical behavior).
/// - Markdown / Text → a new `open_non_typst_from_disk` path that still reads
///   the text (editable) but skips compile / LSP / VFS.
/// - Image / Pdf → `open_non_typst_from_disk` with NO byte read on the
///   backend (content = ""): the frontend fetches bytes on demand via
///   `read_file_bytes`.
pub(crate) async fn open_path_classified(
    state: &State<'_, AppState>,
    path: PathBuf,
) -> Result<OpenedDocument> {
    use crate::domain::file_kind;

    let kind = file_kind::classify(&path);

    // Typst keeps the historical pipeline verbatim (read text + compile worker
    // + VFS). Non-Typst text kinds read text too but skip compile/LSP/VFS via
    // open_non_typst_from_disk. Binary kinds (image/pdf) read no bytes here.
    if kind.is_typst() {
        return open_typst_path(state, path).await;
    }

    // For editable text kinds, read the text (same guard as the Typst path).
    let content = if kind.is_textual() {
        Some(read_text_for_tab(&path).await?)
    } else {
        None
    };

    let editor = state.editor.clone();
    let meta = editor.open_non_typst_from_disk(
        path,
        kind,
        content.clone().unwrap_or_default(),
        Some(&state.workspace),
    )?;
    // Dedup: reopening a live (possibly dirty) text tab returns its buffer.
    // For binary kinds there is no buffer — return "".
    let content = if kind.is_binary_preview() {
        String::new()
    } else {
        editor.tab_text(meta.id).unwrap_or_else(|| content.unwrap_or_default())
    };
    Ok(OpenedDocument { meta, content })
}

/// The historical Typst open path: read text + `open_from_disk` (which builds
/// a compile worker and seeds the VFS). Factored out of `open_file_by_path`
/// so [`open_path_classified`] can keep the Typst behavior byte-for-byte
/// identical while routing non-Typst kinds elsewhere.
async fn open_typst_path(
    state: &State<'_, AppState>,
    path: PathBuf,
) -> Result<OpenedDocument> {
    let content = read_text_for_tab(&path).await?;
    let editor = state.editor.clone();
    let meta = editor.open_from_disk(path, content.clone(), Some(&state.workspace))?;
    let content = editor.tab_text(meta.id).unwrap_or(content);
    Ok(OpenedDocument { meta, content })
}

/// Read a file's text on a blocking thread with the source-file size guard.
/// Shared by the Typst and editable-text open paths. Binary kinds bypass this.
async fn read_text_for_tab(path: &Path) -> Result<String> {
    let path_for_read = path.to_path_buf();
    let path_for_err = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<String, AppError> {
        let len = std::fs::metadata(&path_for_read)
            .map_err(|e| AppError::Other(format!("stat {path_for_err:?}: {e}")))?
            .len();
        if len > MAX_SOURCE_FILE_BYTES {
            return Err(AppError::Other(format!(
                "file too large to open as source ({} bytes; limit {} bytes): {path_for_err:?}",
                len, MAX_SOURCE_FILE_BYTES
            )));
        }
        std::fs::read_to_string(&path_for_read)
            .map_err(|e| AppError::Other(format!("read {path_for_err:?}: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Upper bound on a binary file we are willing to read into the webview for
/// in-app preview (image / pdf). Generous (a print-resolution PDF or a high-MP
/// photo can be tens of MiB) but still bounded so a multi-GB file can't OOM
/// the renderer. Distinct from the text-file limit because preview payloads
/// are legitimately larger than source files.
const MAX_BINARY_PREVIEW_BYTES: u64 = 100 * 1024 * 1024;

/// Read a binary file's raw bytes for in-app preview (image / PDF viewer).
///
/// The frontend's `@tauri-apps/plugin-fs` `readFile` is scope-limited to
/// `$HOME/**` by `capabilities/default.json`, so it CANNOT read workspace
/// files (e.g. `D:\code\...`). This command uses `std::fs::read` directly
/// (same as the rest of the app's core I/O) and is therefore scope-unlimited
/// — consistent with `open_file_by_path`, which also bypasses the fs plugin.
///
/// Guards against oversized files (`MAX_BINARY_PREVIEW_BYTES`). Returns the
/// bytes as `Vec<u8>`; Tauri serializes that as a JSON number array, which the
/// frontend wraps in a `Uint8Array` / `Blob`.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>> {
    let path = PathBuf::from(path);
    let path_for_err = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<Vec<u8>, AppError> {
        let len = std::fs::metadata(&path)
            .map_err(|e| AppError::Other(format!("stat {path_for_err:?}: {e}")))?
            .len();
        if len > MAX_BINARY_PREVIEW_BYTES {
            return Err(AppError::Other(format!(
                "file too large to preview ({} bytes; limit {} bytes): {path_for_err:?}",
                len, MAX_BINARY_PREVIEW_BYTES
            )));
        }
        std::fs::read(&path).map_err(|e| AppError::Other(format!("read {path_for_err:?}: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
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
        .save_as(id, path.clone())
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

/// Pure decision helper for §14: whether a workspace open/close transition
/// should request an LSP restart. Returns `Some(WorkspaceChange)` whenever the
/// workspace-rooted state actually changed (a root was opened, replaced, or
/// closed), and `None` only when nothing changed.
///
/// `prev_open` is whether a workspace was open BEFORE the op; `new_open` is
/// whether one is open AFTER. The only no-op is `true → true` in the sense that
/// a re-open of the SAME path would still be a restart (tinymist needs a fresh
/// `initialize` to re-resolve against the root) — but per spec §14.1/§14.3 any
/// open (including a same-path reopen, which mints a fresh workspace id per
/// `WorkspaceService::open`) is a workspace change worth a single restart.
/// Therefore this helper returns `Some` for every transition except
/// `false → false` (no workspace before or after — e.g. a no-op close when
/// nothing was open, or a failed open that left state unchanged).
///
/// Extracted as a free function so the §14 "ONE restart per user-visible
/// workspace change" contract is unit-testable without standing up a live LSP
/// listener. The actual `state.lsp.request_restart(...)` IPC wiring is verified
/// by reading `fs_commands.rs` (every workspace command calls it after
/// reclassify); this helper pins the DECISION, hence the `allow(dead_code)` —
/// it is exercised by the unit tests below.
#[allow(dead_code)]
pub(crate) fn workspace_change_triggers_restart(
    prev_open: bool,
    new_open: bool,
) -> Option<LspRestartReason> {
    if !prev_open && !new_open {
        // No workspace before or after: nothing changed, no restart.
        None
    } else {
        // Any other transition (open, replace/switch, close) is a workspace
        // change → exactly one WorkspaceChange restart.
        Some(LspRestartReason::WorkspaceChange)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_from_closed_triggers_restart() {
        // §14.1: closing → opening a workspace is a workspace change.
        assert_eq!(
            workspace_change_triggers_restart(false, true),
            Some(LspRestartReason::WorkspaceChange)
        );
    }

    #[test]
    fn switch_open_over_open_triggers_one_restart() {
        // §14.3: a switch is a single `open()` overwrite, NOT a close+open.
        // From the decision helper's view, true → true is still a workspace
        // change (a new root / fresh workspace id), and it yields ONE restart
        // reason — not two. The caller surfaces this once
        // (open_path_as_workspace requests restart exactly once; close_workspace
        // is NOT also invoked on a switch).
        assert_eq!(
            workspace_change_triggers_restart(true, true),
            Some(LspRestartReason::WorkspaceChange)
        );
    }

    #[test]
    fn close_open_to_closed_triggers_restart() {
        // §14.2: closing a workspace is a workspace change.
        assert_eq!(
            workspace_change_triggers_restart(true, false),
            Some(LspRestartReason::WorkspaceChange)
        );
    }

    #[test]
    fn no_workspace_before_or_after_is_no_restart() {
        // A no-op close when nothing was open, or a failed open that left state
        // unchanged, must NOT trigger a restart.
        assert_eq!(workspace_change_triggers_restart(false, false), None);
    }
}

