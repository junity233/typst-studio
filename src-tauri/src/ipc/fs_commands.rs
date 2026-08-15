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

use crate::domain::document::{DocumentId, DocumentKind};
use crate::error::{AppError, Result};
use crate::fs::tree::EntryKind;
use crate::fs::watcher;
use crate::ipc::events::{FsChangedPayload, OpenedDocument};
use crate::ipc::state::AppState;
use crate::lsp::manager::LspRestartReason;
use crate::service::document_service::CasReplaceOutcome;
use crate::service::workspace_service::WorkspaceMeta;

/// Upper bound on a source file we are willing to load into an editor tab via
/// the file tree. See `commands::MAX_SOURCE_FILE_BYTES` for rationale.
const MAX_SOURCE_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Whether `candidate` is contained within `base` (resolving existing ancestors
/// so a symlink can't redirect outside the root). Thin wrapper over the shared
/// [`ensure_contained_path`](crate::domain::path::ensure_contained_path)
/// helper.
fn contained_in(base: &Path, candidate: &Path) -> bool {
    crate::domain::path::ensure_contained_path(base, candidate).is_ok()
}

/// Write base64-encoded `bytes` to absolute `dest`, creating parent dirs as
/// needed. Returns the number of bytes written.
///
/// This is the write path for pasted images: the frontend computes `dest` from
/// the user's `editor.pasteImagePath` template (typically `${fileDir}/assets/…`)
/// and ships the clipboard bytes here. Routing through Rust — instead of
/// `@tauri-apps/plugin-fs` — bypasses the fs plugin's `$HOME` scope, so images
/// land correctly for workspaces opened outside the home directory (e.g. on a
/// second drive), matching how the app's open/save/save-as commands already use
/// `std::fs` directly.
///
/// **Containment:** see [`ensure_paste_dest`](crate::ipc::ensure_paste_dest) —
/// `dest` must live under the open workspace root or the app's config dir (the
/// two legitimate targets for a pasted image). Bytes are passed base64-encoded
/// because the default IPC serializes command args as JSON (avoids a multi-MB
/// number array per image).
#[tauri::command]
pub async fn write_bytes_to_file(
    dest: String,
    bytes_b64: String,
    state: State<'_, AppState>,
) -> Result<u64> {
    let dest_path = crate::ipc::ensure_paste_dest(&state, &dest)?.to_path_buf();
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&bytes_b64)
        .map_err(|e| AppError::InvalidInput(format!("invalid base64 bytes: {e}")))?;
    let len = bytes.len() as u64;
    let dest_buf = dest_path.to_path_buf();
    // Blocking file IO off the async runtime, matching the export commands.
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        if let Some(parent) = dest_buf.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest_buf, &bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(len)
}

/// Apply LSP `TextEdit[]` to a NOT-open workspace file (read → splice →
/// atomic write). This is the disk half of `workspace/applyEdit` for rename
/// refactorings that reach files the app doesn't hold open: the frontend
/// planner routes open-doc edits to Monaco models and everything else here.
/// The watcher picks the write up like any external change, so tinymist and
/// the file tree stay in sync with no extra event plumbing.
#[tauri::command]
pub async fn apply_text_edits_to_disk_file(
    state: State<'_, AppState>,
    uri: String,
    edits: Vec<crate::fs::text_edits::WireTextEdit>,
) -> Result<()> {
    let path = crate::fs::text_edits::file_uri_to_path(&uri)?;
    let root = state
        .workspace
        .root()
        .ok_or_else(|| AppError::InvalidInput("no workspace is open".into()))?;
    if !contained_in(&root, &path) {
        return Err(AppError::InvalidInput(
            "edit target is outside the workspace".into(),
        ));
    }
    // Blocking IO (read + atomic write) off the async runtime, matching the
    // other write commands.
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let text = std::fs::read_to_string(&path)?;
        let new_text = crate::fs::text_edits::apply_text_edits(&text, &edits)?;
        crate::persistence::atomic::write_bytes(&path, new_text.as_bytes())?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(())
}

/// One `.typ` file found by [`list_typst_files`] (absolute + workspace-relative).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct TypstFileEntry {
    pub abs_path: String,
    pub rel_path: String,
}

/// Directories never descended into by [`list_typst_files`] / [`collect_typ_files`].
const TYP_WALK_SKIP_DIRS: [&str; 3] = [".git", "node_modules", "target"];

/// List every `.typ` file under the workspace root, recursively — the picker
/// source for batch export. Skips dot-directories and the common dependency /
/// build directories. Sorted by relative path for a stable listing.
#[tauri::command]
pub async fn list_typst_files(
    state: State<'_, AppState>,
) -> Result<Vec<TypstFileEntry>> {
    let root = state
        .workspace
        .root()
        .ok_or_else(|| AppError::InvalidInput("no workspace is open".into()))?;
    tauri::async_runtime::spawn_blocking(move || Ok(collect_typ_files(&root)))
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Recursive `.typ` walker behind [`list_typst_files`]. Pure-ish (disk IO, no
/// app state) so the skip rules are unit-testable with a tempdir. Matches the
/// editor's own openability rules (`file_kind::TYPST_EXTENSIONS`,
/// case-insensitive). Symlinks are NOT followed — a symlinked directory is
/// skipped (which is also what makes the walk loop-safe), so the listing
/// mirrors real in-tree files only.
fn collect_typ_files(root: &Path) -> Vec<TypstFileEntry> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // unreadable subdir: skip, not fail
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            let path = entry.path();
            if file_type.is_dir() {
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if name.starts_with('.') || TYP_WALK_SKIP_DIRS.contains(&name) {
                    continue;
                }
                stack.push(path);
            } else if let Some(ext) = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
            {
                if crate::domain::file_kind::TYPST_EXTENSIONS.contains(&ext.as_str()) {
                    let rel = path
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    out.push(TypstFileEntry {
                        abs_path: path.to_string_lossy().into_owned(),
                        rel_path: rel,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

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

/// How a `delete_entry` command removed the entry: `"trashed"` (the default,
/// recoverable from the OS trash) or `"permanently_deleted"` (the explicit
/// advanced action). Surfaced so the frontend can show the right confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum DeleteOutcome {
    Trashed,
    PermanentlyDeleted,
}

/// Result of a `delete_entry` command (§5.5). Wire format is camelCase like
/// every other IPC payload struct in this file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DeleteResult {
    pub outcome: DeleteOutcome,
    /// The document ids of any OPEN documents (visible AND soft-closed/hidden)
    /// that were hard-closed because their backing file lived at/under the
    /// deleted entry. The frontend drops these from its tab/document stores
    /// (including the hidden list). Almost always clean docs — dirty/conflicted
    /// docs block the delete (`DeleteBlocked`) up front, and a doc that turned
    /// dirty in the race window after the preflight is kept alive as `Missing`
    /// (see `hard_close_if_clean`) rather than destroyed, so it never appears
    /// here.
    pub closed_doc_ids: Vec<String>,
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
    // Project config hot-reload: an external edit to `<root>/.typstpro` is
    // re-read and re-broadcast. `load` fires `on_change` (→
    // `project_config_changed`) so the panel/preview/export react without each
    // polling. Clone the service so the watcher closure is 'static.
    let project_config_for_cb = state.project_config.clone();
    // The workspace service hands back the CANONICAL root — the exact form the
    // watcher is anchored at (it watches the canonical path) — so the
    // `.typstpro` comparison below matches the event paths. Comparing against
    // the raw picked root instead broke on macOS (`/var` → `/private/var`) and
    // on Windows (case/subst differences): the paths never compared equal and
    // hot-reload silently never fired.
    let workspace_for_cb = state.workspace.clone();
    let on_change: watcher::OnChange = Arc::new(move |paths: &[PathBuf]| {
        // §8.4: route each changed path to the editor so an open document whose
        // backing file changed is reloaded (clean buffer) or marked conflict
        // (dirty buffer / deleted). Safe on the watcher flush thread.
        for p in paths {
            editor_for_cb.handle_external_change(p);
        }
        // Hot-reload the ROOT `.typstpro` when the watcher saw it change
        // (external edit, git checkout, …). Match on both file name AND parent
        // == root so a `.typstpro` in a subdirectory (a backup, a package
        // example, …) doesn't spuriously reload the root config. `load` is
        // idempotent and degrades to None on a missing/corrupt file.
        if let Some(canonical_root) = workspace_for_cb.root() {
            let config_path = canonical_root
                .join(crate::service::project_config_service::CONFIG_FILENAME);
            if paths.iter().any(|p| p == &config_path) {
                project_config_for_cb.load(&canonical_root);
            }
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
    // Peek `.typstpro` BEFORE open so the resolver can anchor at the project's
    // `[compile].root` (Typst's `--root`) from the very first tab. The full
    // load happens after open (below). A peek (no cache/on_change) avoids
    // firing the re-anchor path before a resolver exists.
    let compile_root = crate::service::project_config_service::ProjectConfigService::peek(&root)
        .and_then(|cfg| cfg.compile_root().map(std::path::PathBuf::from));
    let meta = state.workspace.open(
        root,
        std::time::Duration::from_millis(debounce_ms),
        on_change,
        compile_root,
    )?;
    // Load the workspace's `.typstpro` now that the root is established. Uses
    // the canonical root the workspace service stores (not the display string
    // in `meta.root`), matching the path the watcher reloads. Fires
    // `project_config_changed` (None when absent) so the frontend has the
    // project config alongside the workspace metadata on open.
    if let Some(canonical_root) = state.workspace.root() {
        state.project_config.load(&canonical_root);
    }
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
    let picked = super::dialog::pick_folder(&app).await?;
    let Some(root) = picked else {
        return Ok(None);
    };

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
    // Drop the cached `.typstpro` (file is NOT deleted — only the in-memory
    // cache resets) and broadcast None so the frontend clears project state.
    state.project_config.reset();
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
    let exclude = state
        .project_config
        .get()
        .and_then(|c| c.exclude);
    let exclude_gs =
        crate::service::project_config_service::build_exclude_globset(exclude.as_deref());
    let hits = tauri::async_runtime::spawn_blocking(move || ws.search(&query, exclude_gs.as_ref()))
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(hits)
}

/// Replace matches across the workspace (§Search view → Replace). Walks the
/// same file tree as [`search_workspace`] to find candidate files, then routes
/// each affected file to the right sink:
/// - **Open document (visible OR soft-closed)** → spliced from its LIVE buffer
///   text (`tab_text`), then applied via a compare-and-swap on the buffer's
///   text AND revision (`replace_text_cas`) so any write landing between the
///   read and the write forces a recompute-and-retry instead of being silently
///   overwritten; the write marks dirty, publishes to the VFS, and signals the
///   compile worker. Splicing from the buffer — not the disk — is what
///   preserves the user's unsaved edits: an open doc with a dirty buffer may
///   differ from its on-disk content, and a disk-based replacement would
///   silently clobber those edits. The new content + revision are returned so
///   the frontend can mirror them into Monaco via a "controlled replace" (see
///   SearchPanel handshake) — the frontend MUST NOT re-sync via its own
///   `updateText`, or the revision desyncs and the user's next keystroke is
///   dropped.
/// - **Not open** → spliced from disk text and written back to disk (atomic
///   write). No dirty buffer can disagree, because there is no buffer.
///
/// Conflicted open docs are NOT skipped: their buffer is still updated (the
/// user explicitly asked to replace), preserving the "edit the buffer" decision
/// the user made.
#[tauri::command]
pub async fn replace_in_files(
    state: State<'_, AppState>,
    req: crate::domain::search::ReplaceRequest,
) -> Result<crate::domain::search::ReplaceOutcome> {
    let ws = state.workspace.clone();
    let root = ws.root().ok_or_else(|| {
        AppError::InvalidInput("no workspace open".into())
    })?.clone();
    let exclude = state
        .project_config
        .get()
        .and_then(|c| c.exclude);
    let exclude_gs =
        crate::service::project_config_service::build_exclude_globset(exclude.as_deref());

    // 1. Walk the workspace for candidate files (no text read yet) and build
    //    the matcher once. Both run on the blocking pool; the candidates walk
    //    does stat/read_dir IO, and build_replace_matcher compiles a regex.
    let (candidates, matcher) = {
        let req = req.clone();
        let root = root.clone();
        let exclude_gs = exclude_gs.clone();
        tauri::async_runtime::spawn_blocking(move || -> std::result::Result<_, anyhow::Error> {
            let cands = crate::fs::search::replace_candidates(&root, &req, exclude_gs.as_ref());
            let matcher = crate::fs::search::build_replace_matcher(&req)?;
            Ok((cands, matcher))
        })
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?
        .map_err(|e| AppError::Other(e.to_string()))?
    };

    // 2. Which candidates are OPEN documents? docs_at_paths_with_hidden
    //    includes soft-closed (hidden) tabs too — a hidden tab still holds a
    //    live buffer that must be spliced in-memory, not from disk. Index by
    //    canonical path for an O(1) join against the walk.
    let abs_paths: Vec<PathBuf> = candidates.iter().map(|c| c.abs_path.clone()).collect();
    let open_docs = state.editor.document().docs_at_paths_with_hidden(&abs_paths);
    let mut open_by_canon: std::collections::HashMap<PathBuf, DocumentId> =
        std::collections::HashMap::new();
    for d in &open_docs {
        open_by_canon.insert(d.path.clone(), d.id);
    }

    // 3. Compute each file's replacement, reading text from the right source
    //    (live buffer for open docs, disk for closed), then route to its sink.
    //    Open-doc splices run inline (they need AppState → update_text); the
    //    disk reads for closed files are deferred to the blocking batch below
    //    alongside their writes so we cross the async/blocking boundary once.
    let mut open_results: Vec<crate::domain::search::OpenDocReplacement> = Vec::new();
    // Open docs whose replacement could NOT be applied because the buffer kept
    // changing under us (revision races) — surfaced in `failed` so the
    // response reports exactly what was applied.
    let mut open_failures: Vec<crate::domain::search::ReplaceFailure> = Vec::new();
    let mut closed: Vec<crate::fs::search::ReplaceCandidate> = Vec::new();
    for cand in candidates {
        // Canonicalize the walked path the same way docs_at_paths_with_hidden
        // did so the join succeeds regardless of symlinks/`..` in the abs path.
        let canon = crate::domain::path::canonicalize_for_identity(&cand.abs_path)
            .unwrap_or_else(|_| cand.abs_path.clone());
        if let Some(id) = open_by_canon.get(&canon).copied() {
            // Open: splice from the LIVE buffer text. tab_text returns the
            // in-memory buffer (possibly dirty, possibly diverged from disk);
            // replacing on top of THAT is what keeps unsaved edits intact. A
            // None revision/text means the tab vanished mid-batch (closed
            // concurrently) — skip it rather than fall back to disk, which
            // would race the just-closed buffer's save.
            //
            // The read→write is a COMPARE-AND-SWAP on the buffer's text AND
            // revision (`replace_text_cas`): the splice is computed from an
            // observed text+revision snapshot and applied only when the buffer
            // still holds exactly that state under the tab lock. ANY write
            // landing between the read and the CAS — a keystroke that bumped
            // the revision, or even a same-revision text swap — makes the
            // check miss; the intervening edit is never overwritten. On a miss
            // nothing is written and the CAS hands back the fresh text +
            // revision, so the loop recomputes the splice from the fresh
            // buffer and retries, bounded. On a hit the applied revision is
            // observed+1: the Monaco controlled-replace mirror rejects
            // `revision <= lastSynced`, so the returned revision must be
            // strictly newer than the one we read. A doc that keeps racing is
            // reported in `failed` instead of being force-overwritten.
            const MAX_REVISION_RETRIES: usize = 3;
            let mut replacement: Option<crate::domain::search::OpenDocReplacement> = None;
            let mut raced_out = false;
            for attempt in 0..MAX_REVISION_RETRIES {
                let doc = state.editor.document();
                let Some(revision) = doc.tab_revision(id) else { break };
                let Some(buf_text) = doc.tab_text(id) else { break };
                let Some(fr) = crate::fs::search::compute_file_replacement(
                    &buf_text, &req, &matcher, &cand.relative, cand.abs_path.clone(),
                ) else {
                    break;
                };
                match doc.replace_text_cas(id, &buf_text, fr.new_content.clone(), revision) {
                    Ok(CasReplaceOutcome::Applied { revision: applied_revision }) => {
                        // CAS success: publish the content + revision the
                        // buffer actually holds (the handshake contract).
                        replacement = Some(crate::domain::search::OpenDocReplacement {
                            id,
                            new_content: fr.new_content,
                            new_revision: applied_revision,
                            path: canon.to_string_lossy().into_owned(),
                        });
                        break;
                    }
                    Ok(CasReplaceOutcome::Conflated { revision: current_revision, .. }) => {
                        // Buffer moved under us — our splice was computed from
                        // a stale snapshot. Retry from the fresh buffer.
                        tracing::warn!(
                            doc = %id,
                            attempt,
                            current_revision,
                            "replace_in_files: open-doc buffer moved; retrying from fresh text"
                        );
                        raced_out = attempt + 1 == MAX_REVISION_RETRIES;
                    }
                    Err(e) => return Err(e),
                }
            }
            match replacement {
                Some(r) => open_results.push(r),
                None if raced_out => open_failures.push(crate::domain::search::ReplaceFailure {
                    relative: cand.relative.clone(),
                    reason: format!(
                        "buffer kept changing while replacing; no replacement \
                         applied after {MAX_REVISION_RETRIES} attempts"
                    ),
                }),
                None => {}
            }
        } else {
            // Closed: defer to the blocking batch below, which reads disk text,
            // splices, and writes atomically in one blocking hop.
            closed.push(cand);
        }
    }

    // 4. Read + splice + atomically-write every closed file on the blocking
    //    pool, collecting failures. A single closed-file failure (permission
    //    denied, disk full, vanished mid-batch) does NOT abort the rest: we
    //    record it in `failed` and continue, so the user gets a partial-success
    //    summary instead of a half-applied batch with no detail. Uses the
    //    project's atomic write (temp + fsync + rename + perm-preserve) — the
    //    same protocol Saves use — so a crash mid-batch can never truncate a
    //    workspace file.
    let closed_written: u32;
    let mut failed: Vec<crate::domain::search::ReplaceFailure> = open_failures;
    if closed.is_empty() {
        closed_written = 0;
    } else {
        let req = req.clone();
        let matcher = matcher.clone();
        let written = tauri::async_runtime::spawn_blocking(move || {
            let mut ok = 0u32;
            let mut failures: Vec<crate::domain::search::ReplaceFailure> = Vec::new();
            for cand in &closed {
                // Read disk text; a non-UTF-8 / unreadable file is a soft
                // failure (reported, not fatal) — same best-effort as `search`.
                let text = match std::fs::read_to_string(&cand.abs_path) {
                    Ok(t) => t,
                    Err(e) => {
                        failures.push(crate::domain::search::ReplaceFailure {
                            relative: cand.relative.clone(),
                            reason: e.to_string(),
                        });
                        continue;
                    }
                };
                let Some(fr) = crate::fs::search::compute_file_replacement(
                    &text, &req, &matcher, &cand.relative, cand.abs_path.clone(),
                ) else {
                    continue;
                };
                match crate::persistence::atomic::write_bytes(&fr.abs_path, fr.new_content.as_bytes()) {
                    Ok(()) => ok += 1,
                    Err(e) => failures.push(crate::domain::search::ReplaceFailure {
                        relative: cand.relative.clone(),
                        reason: e.to_string(),
                    }),
                }
            }
            (ok, failures)
        })
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?;
        closed_written = written.0;
        failed.extend(written.1);
    };

    Ok(crate::domain::search::ReplaceOutcome {
        closed_files_written: closed_written,
        open_docs: open_results,
        failed,
    })
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

/// Which disk operation [`delete_entry_impl`] runs: system trash (default) or
/// permanent removal (the explicit advanced action).
#[derive(Clone, Copy)]
enum DeleteMode {
    Trash,
    Permanent,
}

/// Shared body of `delete_entry` / `delete_entry_permanent`: the §5.5
/// open-doc preflight, the disk op on the blocking pool (the Windows recycle
/// API and `remove_dir_all` are unbounded blocking IO), then hard-closing the
/// affected clean docs. The two commands differ ONLY in the disk op.
async fn delete_entry_impl(
    state: State<'_, AppState>,
    rel: String,
    mode: DeleteMode,
) -> Result<DeleteResult> {
    let ws = state.workspace.clone();
    let target = ws.resolve_path(&rel)?;
    // §5.5 open-doc check. The IPC layer has AppState (workspace + editor),
    // so this is the right place — WorkspaceService is disk-only.
    let affected = block_on_unsaved_or_conflicted(&state, &rel, &target)?;
    // The double `?` unwraps the join error, then the service's own Result.
    let outcome = tauri::async_runtime::spawn_blocking(move || match mode {
        DeleteMode::Trash => ws.delete_entry(&rel),
        DeleteMode::Permanent => ws.delete_entry_permanent(&rel),
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    let closed_doc_ids = hard_close_affected(&state, affected);
    Ok(DeleteResult {
        outcome: match outcome {
            crate::service::trash::TrashOutcome::Trashed => DeleteOutcome::Trashed,
            crate::service::trash::TrashOutcome::PermanentlyDeleted => {
                DeleteOutcome::PermanentlyDeleted
            }
        },
        closed_doc_ids,
    })
}

/// Delete a workspace-relative file or directory via the system trash (§5.5).
///
/// §5.5 dirty-delete protection: BEFORE trashing, scan the open-document
/// registry for any doc (visible OR soft-closed/hidden) whose canonical path is
/// AT or UNDER the delete target. If ANY is dirty or conflicted, the delete is
/// REJECTED with `ErrorCode::DeleteBlocked` (carrying the affected doc ids +
/// paths in `details`) — the frontend tells the user to save/close/discard
/// those docs first. Clean open docs (visible and hidden) do NOT block — they
/// are hard-closed after the trash op (see `hard_close_affected`) so they don't
/// linger as zombies feeding the conflict dialog.
#[tauri::command]
pub async fn delete_entry(state: State<'_, AppState>, rel: String) -> Result<DeleteResult> {
    delete_entry_impl(state, rel, DeleteMode::Trash).await
}

/// Reject the operation with `DeleteBlocked` if any dirty or conflicted document
/// (visible OR hidden — a dirty hidden tab still holds unsaved edits) is open AT
/// or UNDER `target`. Returns all affected docs when the delete may proceed so
/// the caller can hard-close the clean ones.
fn block_on_unsaved_or_conflicted(
    state: &State<'_, AppState>,
    rel: &str,
    target: &std::path::Path,
) -> std::result::Result<Vec<crate::service::document_service::AffectedDoc>, AppError> {
    let affected = state.editor.document().docs_under_path_with_hidden(target);
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
    Err(AppError::ipc(
        crate::ipc::error::ErrorCode::DeleteBlocked,
        format!(
            "{n} unsaved or conflicted document(s) open under '{rel}'; save, resolve, close, or discard them before deleting."
        ),
        true,
        Some(details),
    ))
}

/// Hard-close every clean open document (visible or hidden) at/under a
/// just-deleted entry. The disk delete already succeeded, so these docs now
/// back a file that no longer exists. Keeping them alive left a "zombie"
/// whose watcher events surfaced spurious conflict dialogs — and on Windows
/// the trash op's intermediate events misclassified the delete as `Modified`.
/// Hard-closing releases the worker + VFS + registry slot, so the watcher's
/// later `handle_external_change` for the deleted path finds no open document
/// and returns immediately.
///
/// Closes go through `hard_close_if_clean`, which re-checks dirty/conflict
/// under the doc's state lock: a keystroke landing between the preflight and
/// this close (the trash op in between can be slow) must NOT be silently
/// destroyed — the raced-dirty doc is instead kept alive and marked `Missing`
/// (the watcher-equivalent recoverable state) and is simply absent from the
/// returned ids. Returns the closed ids as strings so the frontend can drop
/// them from its stores.
fn hard_close_affected(
    state: &State<'_, AppState>,
    affected: Vec<crate::service::document_service::AffectedDoc>,
) -> Vec<String> {
    affected
        .into_iter()
        .filter(|doc| {
            // Best-effort: a doc can't race-close between the preflight and
            // here in practice; a NotFound just means someone else closed it.
            state.editor.document().hard_close_if_clean(doc.id)
        })
        .map(|doc| doc.id.to_string())
        .collect()
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
    delete_entry_impl(state, rel, DeleteMode::Permanent).await
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
    let meta = editor.tab_meta(id);
    let default_name = meta
        .as_ref()
        .and_then(|m| {
            m.path
                .as_ref()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
        .unwrap_or_else(|| "Untitled.typ".to_string());
    // The dialog filter follows the tab's KIND: save_as serves Markdown and
    // plain-text tabs too (open_non_typst_from_disk), and a hard-coded Typst
    // filter would push those saves into `.typ` filenames (flipping the tab
    // into Typst behavior on re-parse). Only the typst kind keeps the
    // historical filter; markdown gets its extensions; text and the binary
    // preview kinds get no filter (any extension).
    let filters: &[super::dialog::DialogFilter] = match meta.as_ref().map(|m| m.kind) {
        Some(DocumentKind::Markdown) => &[("Markdown", &["md", "markdown"])],
        Some(DocumentKind::Text) | Some(DocumentKind::Image) | Some(DocumentKind::Pdf) => &[],
        // The typst kind (and a missing tab — the save itself will fail
        // with NotFound) keeps the historical Typst filter.
        None | Some(DocumentKind::Typst) => &[("Typst", &["typ"])],
    };
    let picked = super::dialog::save_file(&app, filters, Some(&default_name)).await?;
    let Some(path) = picked else {
        // §5.3: a cancelled dialog is surfaced as the Cancelled code (not a
        // generic Other). The frontend no-ops on this.
        return Err(AppError::ipc(
            crate::ipc::error::ErrorCode::Cancelled,
            "save cancelled",
            false,
            None,
        ));
    };
    // Delegate the atomic write + rebind to the SaveCoordinator (§5.2 / §11.2:
    // rebind only after the replace succeeds).
    state
        .save
        .save_as(id, path.clone())
        .await
        .map_err(AppError::from)?;
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
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        TypstFileEntry::export(&cfg).unwrap();
    }

    #[test]
    fn collect_typ_files_finds_nested_typ_and_skips_ignored_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("main.typ"), "x").unwrap();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("chapters").join("a.typ"), "x").unwrap();
        // Skipped: dot-dir, .git, node_modules — and non-.typ files.
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden").join("h.typ"), "x").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("g.typ"), "x").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("n.typ"), "x").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();

        let found = collect_typ_files(root);
        let rels: Vec<&str> = found.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, ["chapters/a.typ", "main.typ"]);
        // Absolute paths round-trip to real files.
        assert!(found.iter().all(|f| Path::new(&f.abs_path).is_file()));
    }

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

