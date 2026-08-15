//! Tauri `#[tauri::command]` definitions — the IPC surface.
//!
//! Each command is a thin adapter: it converts IPC arguments into a service call
//! and maps the [`Result`] into the `Result<T, AppError>` Tauri auto-serializes.
//!
//! ## Threading
//!
//! All commands that touch the disk or native dialogs are `async`. Sync
//! commands in Tauri 2 run on the **main thread** — calling a blocking dialog
//! or `std::fs` from a sync command would freeze the webview. Async commands
//! run on the Tauri async runtime, and we wrap any remaining blocking IO in
//! [`tauri::async_runtime::spawn_blocking`].

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::domain::diagnostics::Diagnostic;
use crate::domain::document::{DocumentId, DocumentMeta};
use crate::error::{AppError, Result};
use crate::ipc::events::{LspStatusPayload, OpenedDocument};
use crate::ipc::state::AppState;

/// Create a new untitled tab. Seed precedence when `content` is omitted:
/// project `newFileTemplate` (a workspace-relative file, read from disk) >
/// global `document.defaultTemplate` (inline text) > the built-in literal.
/// The initial compile is spawned asynchronously — this returns immediately.
#[tauri::command]
pub async fn new_tab(state: State<'_, AppState>, content: Option<String>) -> Result<OpenedDocument> {
    let content = match content {
        Some(c) => Some(c),
        None => seed_new_tab_content(&state)?,
    };
    let editor = state.editor.clone();
    let meta = editor.new_tab(content);
    let content_text = editor.tab_text(meta.id).unwrap_or_default();
    Ok(OpenedDocument {
        meta,
        content: content_text,
    })
}

/// Resolve the seed content for a new untitled tab. Project `newFileTemplate`
/// (workspace-relative path) wins over the global inline `defaultTemplate`.
fn seed_new_tab_content(state: &State<'_, AppState>) -> Result<Option<String>> {
    // Project newFileTemplate: resolve against the workspace root and read it.
    if let Some(tmpl_rel) = state
        .project_config
        .get()
        .and_then(|c| c.new_file_template)
    {
        if let Some(root) = state.workspace.root() {
            // The value is already guaranteed workspace-relative upstream: it
            // either survived load-time sanitize_loaded_paths (which drops
            // escaping paths) or passed set-time validate_config_paths (which
            // rejects them). So root.join cannot escape.
            let p = root.join(&tmpl_rel);
            match std::fs::read_to_string(&p) {
                Ok(text) => return Ok(Some(text)),
                Err(e) => tracing::warn!(?p, error = %e, "newFileTemplate unreadable; falling back"),
            }
        }
    }
    // Global inline defaultTemplate.
    let tmpl = state.settings.get_or_default::<String>("document.defaultTemplate");
    Ok(if tmpl.is_empty() { None } else { Some(tmpl) })
}

/// Open a native file dialog, read the chosen file, and open it as a tab.
/// Returns `None` if the user cancels the dialog.
#[tauri::command]
pub async fn open_file(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OpenedDocument>> {
    // The dialog's blocking API runs the native panel on the main thread while
    // this worker thread waits — the webview's event loop is never stalled.
    //
    // Filters are grouped by category so the user can open any document the app
    // supports: Typst sources (default), other editable text, images, and PDFs.
    // Typst is listed first so it stays the OS-default filter on each launch.
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("Typst", &["typ", "typst"])
            .add_filter(
                "Documents",
                &[
                    "md", "markdown", "txt", "json", "csv", "log", "ts", "js", "py", "html", "css",
                    "yaml", "yml", "toml", "xml",
                ],
            )
            .add_filter("Images", &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"])
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = path_buf_from(picked)?;
    // Delegate to the shared classified open path (same code the file-tree and
    // single-instance router use), so the dialog and the tree classify files
    // identically and a file opened either way behaves the same.
    let doc = crate::ipc::fs_commands::open_path_classified(&state, path).await?;
    Ok(Some(doc))
}

/// Open a native image-picker dialog and return the chosen file's absolute
/// path as a string. Returns `None` if the user cancels. Bytes are read by
/// the frontend via the `@tauri-apps/plugin-fs` plugin — this command only
/// resolves the path, mirroring how `open_file` resolves a `.typ` path while
/// leaving content IO to the caller.
#[tauri::command]
pub async fn pick_image_file(app: AppHandle) -> Result<Option<String>> {
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter(
                "Images",
                &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = path_buf_from(picked)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Close a tab, releasing its world and caches.
#[tauri::command]
pub async fn close_tab(state: State<'_, AppState>, id: DocumentId) -> Result<()> {
    state.editor.close_tab(id)
}

/// Soft-close a tab (§B1): hide it from the tab strip but keep its worker,
/// EditorWorld, cached compile result, and registry entry alive for instant
/// reactivation. The frontend's LRU policy later upgrades old hidden docs to a
/// true close via [`hard_close_tab`].
#[tauri::command]
pub async fn soft_close_tab(state: State<'_, AppState>, id: DocumentId) -> Result<()> {
    state.editor.soft_close(id)
}

/// Reactivate a soft-closed tab (§B1): mark it visible again and, if a cached
/// compile result exists, replay it as a `compiled` event (no recompilation).
/// Returns the current `DocumentMeta` so the frontend can re-add the tab in one
/// round-trip.
#[tauri::command]
pub async fn reactivate_tab(state: State<'_, AppState>, id: DocumentId) -> Result<DocumentMeta> {
    state.editor.reactivate(id)
}

/// Hard-close a tab (§B1, the LRU-eviction path): destroy worker + world +
/// registry entry + VFS — the old `close_tab` destroy-everything behavior.
#[tauri::command]
pub async fn hard_close_tab(state: State<'_, AppState>, id: DocumentId) -> Result<()> {
    state.editor.hard_close(id)
}

/// Apply a versioned source snapshot and schedule a compile.
///
/// `revision` is allocated by the frontend before debounce. The service adopts
/// that exact value and ignores older snapshots, so coalescing several Monaco
/// changes into one IPC does not make the frontend and backend clocks diverge.
/// Returns the backend's authoritative revision after applying (or ignoring)
/// the request.
#[tauri::command]
pub async fn update_text(
    state: State<'_, AppState>,
    id: DocumentId,
    content: String,
    revision: u64,
) -> Result<u64> {
    state.editor.update_text_at_revision(id, content, revision)
}

/// Write a tab's source back to its on-disk path (errors for untitled tabs).
///
/// §5.3: delegates to the [`SaveCoordinator`](crate::service::save_coordinator::SaveCoordinator),
/// which runs the full §5.2 atomic-save protocol (prepare → atomic write →
/// mark_saved) and tracks `SaveState`. On a write failure the coordinator keeps
/// `dirty` TRUE (§11.2) and classifies the error into a structured
/// [`IpcError`](crate::ipc::error::IpcError) code. Tauri serializes the
/// returned `AppError` as that object so the frontend can branch on `code`.
#[tauri::command]
pub async fn save_file(state: State<'_, AppState>, id: DocumentId) -> Result<()> {
    state.save.save(id).await.map_err(|ipc| {
        // Re-wrap the classified IpcError back through AppError so the existing
        // `Result<T, AppError>` contract + AppError::serialize (which emits the
        // IpcError object) is preserved.
        match ipc.code {
            crate::ipc::error::ErrorCode::NotFound => {
                AppError::NotFound(ipc.message)
            }
            _ => AppError::Code {
                code: ipc.code,
                message: ipc.message,
                recoverable: ipc.recoverable,
                details: ipc.details,
            },
        }
    })
}

/// Query the current [`SaveState`](crate::service::save_coordinator::SaveState)
/// for a document (§5.3). The frontend uses this to drive the saving /
/// save-failed status indicator (it also subscribes to the `save_state_changed`
/// event for live transitions).
#[tauri::command]
pub async fn save_state(
    state: State<'_, AppState>,
    id: DocumentId,
) -> Result<crate::service::save_coordinator::SaveState> {
    Ok(state.save.save_state(id))
}

/// Save All: save each document in `ids` in order (§5.3). Stops on the first
/// failure or cancel; already-saved documents stay Saved, the rest are left
/// untouched. Returns a per-doc split so the frontend can report which were
/// saved and which need attention.
#[tauri::command]
pub async fn save_all(
    state: State<'_, AppState>,
    ids: Vec<DocumentId>,
) -> Result<crate::service::save_coordinator::SaveAllResult> {
    Ok(state.save.save_all(ids).await)
}

/// Export the tab's compiled document for `revision` to PDF via a save dialog.
/// Returns the path the PDF was written to. Render + write both run on a
/// blocking thread. `revision` (§9) pins the result to the revision the user is
/// looking at: if that revision already compiled successfully it is rendered;
/// if mid-compile, export waits (bounded); if it failed, its diagnostics are
/// returned. Never silently renders an older revision's document.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    id: DocumentId,
    revision: u64,
    output_path: Option<String>,
) -> Result<String> {
    // When `output_path` is provided (the project's `[export] outputPath`,
    // macro-expanded by the frontend), skip the save dialog and write there
    // directly; otherwise prompt as before. The explicit path is containment-
    // checked and normalized by `ensure_export_within_workspace`; the write
    // then targets exactly the validated path.
    let path = match output_path {
        Some(p) => ensure_export_within_workspace(&state, &PathBuf::from(p))?,
        None => {
            let app_for_dialog = app.clone();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app_for_dialog
                    .dialog()
                    .file()
                    .add_filter("PDF", &["pdf"])
                    .blocking_save_file()
            })
            .await
            .map_err(|e| AppError::Other(format!("join error: {e}")))?;
            let Some(picked) = picked else {
                return Err(AppError::Other("export cancelled".into()));
            };
            path_buf_from(picked)?
        }
    };
    let path_str = path.to_string_lossy().to_string();
    let export = state.export.clone();
    let revision_wait = std::time::Duration::from_millis(
        state.settings.get_or_default::<u64>("export.revisionWaitMs"),
    );
    let pdf_options = pdf_options_from_state(&state)?;
    // Render (CPU-bound) + write (blocking IO) together on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let bytes = export.render_pdf_with_options(id, revision, revision_wait, &pdf_options)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write: auto-export-on-save makes routine exports, and a quit
        // mid-write must never leave a truncated PDF at the output path.
        crate::persistence::atomic::write_bytes(&path, &bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(path_str)
}

/// One document to render in a batch export: the backend tab id, the pinned
/// revision, and the file stem used for the output name (`{name}.pdf`).
#[derive(Debug, Clone, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct BatchExportItem {
    pub id: DocumentId,
    /// Serialized as a JSON number by Tauri (u64 → bigint is overridden, same
    /// as every other wire revision field).
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub revision: u64,
    pub name: String,
}

/// Per-item outcome of a batch export: the written path on success, or the
/// error message (a failed document never aborts the rest of the batch).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct BatchExportOutcome {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export-types", ts(optional))]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export-types", ts(optional))]
    pub error: Option<String>,
}

/// Read the `export.pdf*` settings and build the `PdfOptions` for this run.
/// An invalid value (bad page-range expression, unknown standard) errors the
/// whole export up front — better one clear dialog than N per-file failures.
fn pdf_options_from_state(state: &State<'_, AppState>) -> Result<typst_pdf::PdfOptions> {
    crate::render::pdf_options::pdf_options_from_settings(
        &state.settings.get_or_default::<String>("export.pdfPageRanges"),
        &state.settings.get_or_default::<String>("export.pdfStandard"),
        state.settings.get_or_default::<bool>("export.pdfTagged"),
    )
}

/// Export several compiled documents to one user-picked folder as PDFs, in one
/// pass. The frontend supplies `{id, revision, name}` per document (opening
/// backend-only tabs for closed files and closing them afterwards). The
/// output folder is picked by a native dialog INSIDE this command — the same
/// trust model as `export_pdf`'s save dialog: the webview never supplies a
/// write path, so no containment check is needed (a user-picked folder may be
/// anywhere on disk). Failures are per-item: one broken document doesn't
/// abort the batch.
#[tauri::command]
pub async fn export_batch_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<BatchExportItem>,
) -> Result<Vec<BatchExportOutcome>> {
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else {
        return Err(AppError::Other("export cancelled".into()));
    };
    let dir = path_buf_from(picked)?;
    let export = state.export.clone();
    let revision_wait = std::time::Duration::from_millis(
        state.settings.get_or_default::<u64>("export.revisionWaitMs"),
    );
    let pdf_options = pdf_options_from_state(&state)?;
    let outcomes = tauri::async_runtime::spawn_blocking(
        move || -> Result<Vec<BatchExportOutcome>> {
            std::fs::create_dir_all(&dir)?;
            let mut outcomes = Vec::with_capacity(items.len());
            // Authoritative per-run name dedupe: two inputs that sanitize to
            // the same stem (frontend preview aside) must not overwrite each
            // other's `{stem}.pdf`. The frontend's uniquifyStems is a display
            // nicety; this is the guard that counts.
            let mut used_names: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            for item in items {
                // Sanitize the caller-supplied name down to a file stem —
                // never a path separator hop out of the chosen directory.
                let base = sanitize_file_stem(&item.name);
                let mut stem = base.clone();
                let mut n = 1;
                while !used_names.insert(stem.clone()) {
                    n += 1;
                    stem = format!("{base}-{n}");
                }
                let target = dir.join(format!("{stem}.pdf"));
                let result = export
                    .render_pdf_with_options(item.id, item.revision, revision_wait, &pdf_options)
                    .and_then(|bytes| {
                        // Atomic write: an app quit mid-batch (auto-export
                        // paths make routine exports common) must never leave
                        // a truncated PDF at a displayed path.
                        crate::persistence::atomic::write_bytes(&target, &bytes)?;
                        Ok(target.to_string_lossy().into_owned())
                    });
                outcomes.push(match result {
                    Ok(path) => BatchExportOutcome {
                        name: item.name,
                        path: Some(path),
                        error: None,
                    },
                    Err(e) => BatchExportOutcome {
                        name: item.name,
                        path: None,
                        error: Some(e.to_string()),
                    },
                });
            }
            Ok(outcomes)
        },
    )
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(outcomes)
}

/// Reduce a caller-supplied output name to a safe file stem: map anything
/// that isn't a Unicode alphanumeric or `._- ` to `_` (so path separators and
/// punctuation can't smuggle structure), trim leading/trailing dots so the
/// stem is never a `..` traversal component, and fall back to `document`
/// when nothing survives. Windows reserved names (CON, COM1, …) pass
/// through — the per-item error path reports the failed write.
fn sanitize_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

/// Export each page of the tab's compiled document for `revision` to a PNG. A
/// save dialog picks the output location; pages are named `{stem}-{n}.png` in
/// that folder. Render + write run on a blocking thread. See
/// [`export_pdf`] for the `revision` semantics (§9).
#[tauri::command]
pub async fn export_png(
    app: AppHandle,
    state: State<'_, AppState>,
    id: DocumentId,
    revision: u64,
    output_path: Option<String>,
) -> Result<Vec<String>> {
    let picked_path = match output_path {
        Some(p) => ensure_export_within_workspace(&state, &PathBuf::from(p))?,
        None => {
            let app_for_dialog = app.clone();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app_for_dialog
                    .dialog()
                    .file()
                    .add_filter("PNG", &["png"])
                    .blocking_save_file()
            })
            .await
            .map_err(|e| AppError::Other(format!("join error: {e}")))?;
            let Some(picked) = picked else {
                return Err(AppError::Other("export cancelled".into()));
            };
            path_buf_from(picked)?
        }
    };
    let save_dir = picked_path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("chosen path has no parent directory".into()))?
        .to_path_buf();
    let base_name = picked_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let export = state.export.clone();
    let revision_wait = std::time::Duration::from_millis(
        state.settings.get_or_default::<u64>("export.revisionWaitMs"),
    );
    let pixel_per_pt = state.settings.get_or_default::<f64>("export.pngPixelPerPt");
    let base_name_clone = base_name.clone();
    // Render (CPU-bound) + write (blocking IO) together on a blocking thread.
    let paths = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let pages = export.render_pngs(id, revision, &base_name_clone, revision_wait, pixel_per_pt)?;
        std::fs::create_dir_all(&save_dir)?;
        let mut written = Vec::with_capacity(pages.len());
        for (name, bytes) in pages {
            let full = save_dir.join(&name);
            // Atomic write (same as export_pdf): auto-export-on-save paths
            // make routine exports common, and an app quit mid-batch must
            // never leave a truncated page image at a displayed path.
            crate::persistence::atomic::write_bytes(&full, &bytes)?;
            written.push(full.to_string_lossy().to_string());
        }
        Ok(written)
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(paths)
}

/// Export each page of the tab's compiled document for `revision` to an SVG
/// file. A save dialog picks the output location; pages are named
/// `{stem}-{n}.svg` in that folder. Render + write run on a blocking thread.
/// See [`export_pdf`] for the `revision` semantics (§9).
#[tauri::command]
pub async fn export_svg(
    app: AppHandle,
    state: State<'_, AppState>,
    id: DocumentId,
    revision: u64,
    output_path: Option<String>,
) -> Result<Vec<String>> {
    let picked_path = match output_path {
        Some(p) => ensure_export_within_workspace(&state, &PathBuf::from(p))?,
        None => {
            let app_for_dialog = app.clone();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app_for_dialog
                    .dialog()
                    .file()
                    .add_filter("SVG", &["svg"])
                    .blocking_save_file()
            })
            .await
            .map_err(|e| AppError::Other(format!("join error: {e}")))?;
            let Some(picked) = picked else {
                return Err(AppError::Other("export cancelled".into()));
            };
            path_buf_from(picked)?
        }
    };
    let save_dir = picked_path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("chosen path has no parent directory".into()))?
        .to_path_buf();
    let base_name = picked_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let export = state.export.clone();
    let revision_wait = std::time::Duration::from_millis(
        state.settings.get_or_default::<u64>("export.revisionWaitMs"),
    );
    let base_name_clone = base_name.clone();
    // Render (CPU-bound) + write (blocking IO) together on a blocking thread.
    let paths = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let pages = export.render_svgs(id, revision, &base_name_clone, revision_wait)?;
        std::fs::create_dir_all(&save_dir)?;
        let mut written = Vec::with_capacity(pages.len());
        for (name, bytes) in pages {
            let full = save_dir.join(&name);
            // Atomic write (same as export_pdf): auto-export-on-save paths
            // make routine exports common, and an app quit mid-batch must
            // never leave a truncated page image at a displayed path.
            crate::persistence::atomic::write_bytes(&full, &bytes)?;
            written.push(full.to_string_lossy().to_string());
        }
        Ok(written)
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(paths)
}

/// Fetch the current diagnostics for a tab (used on initial load).
#[tauri::command]
pub async fn get_diagnostics(
    state: State<'_, AppState>,
    id: DocumentId,
) -> Result<Vec<Diagnostic>> {
    Ok(state.editor.get_diagnostics(id))
}

/// Get the LSP server status (§6.4 generation-aware payload). The frontend
/// seeds its store from this on mount and then subscribes to the `lsp_status`
/// event for live transitions.
#[tauri::command]
pub async fn get_lsp_status(state: State<'_, AppState>) -> Result<LspStatusPayload> {
    Ok(state.lsp.status().into())
}

/// Restart the LSP server (e.g. after the user clicks "Restart Language
/// Server"). Routes through `restart()` which stamps the `Manual` reason.
#[tauri::command]
pub async fn restart_lsp(state: State<'_, AppState>) -> Result<()> {
    state.lsp.restart();
    Ok(())
}

/// Snapshot of the managed tinymist install (state, progress, installed
/// version/path). The Settings window + StatusBar seed from this and then
/// subscribe to `tinymist_install` events.
#[tauri::command]
pub async fn get_tinymist_install(
    state: State<'_, AppState>,
) -> Result<crate::lsp::installer::TinymistInstallStatus> {
    Ok(state.tinymist.status())
}

/// Start (or join) a managed tinymist download into ~/.typststudio/.
/// Fire-and-forget: the command returns the current status immediately and
/// all progress arrives via `tinymist_install` events.
#[tauri::command]
pub async fn install_tinymist(
    state: State<'_, AppState>,
) -> Result<crate::lsp::installer::TinymistInstallStatus> {
    state.tinymist.begin_install();
    Ok(state.tinymist.status())
}

/// Convert a dialog `FilePath` into a `PathBuf`, rejecting URLs we can't resolve.
/// Shared by the image/path pickers and the settings path picker.
pub(crate) fn path_buf_from(picked: tauri_plugin_fs::FilePath) -> Result<PathBuf> {
    picked
        .into_path()
        .map_err(|e| AppError::InvalidInput(format!("invalid file path: {e}")))
}

/// Validate an export `output_path` against the open workspace and return the
/// normalized path the caller should actually write.
///
/// Requires an open workspace: the ONLY legitimate source of an explicit
/// `output_path` is the project's `[export] outputPath` macro-expanded by the
/// frontend (`doExport` in `extensions/workbench`), and that flow bails to the
/// save dialog when no workspace root exists — so `Some(path)` with no
/// workspace can only come from a compromised/foreign frontend. The save-dialog
/// path (`output_path: None`) never reaches here and stays user-chosen.
///
/// Containment is delegated to
/// [`ensure_contained_path`](crate::domain::path::ensure_contained_path). A
/// pure lexical `..`-fold is NOT sufficient, and neither is an
/// `Path::exists()`-based ancestor walk: a repo-shipped DANGLING symlink
/// (`build/evil.pdf -> C:\Users\x\missing.pdf`) has `exists() == false`, so an
/// exists()-walk mistakes the link for a "missing tail", lexically appends it
/// under the root, and passes the check — after which `std::fs::write` FOLLOWS
/// the dangling link and creates the file outside the workspace.
/// `ensure_contained_path` probes ancestors with `symlink_metadata` (which
/// sees the link itself, dangling or not), so a symlink anywhere on the path
/// either resolves via `canonicalize` (and is checked against the canonical
/// root) or fails to canonicalize (a dangling link) and is rejected outright.
fn ensure_export_within_workspace(
    state: &State<'_, AppState>,
    path: &std::path::Path,
) -> Result<std::path::PathBuf> {
    let Some(root) = state.workspace.root() else {
        return Err(AppError::InvalidInput(
            "explicit export output path requires an open workspace".into(),
        ));
    };
    // Anchor a relative pattern (e.g. `build/${title}.pdf` expanded relative)
    // at the root before the containment walk.
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    match crate::domain::path::ensure_contained_path(&root, &abs) {
        // Write the LEXICALLY NORMALIZED path that was validated, not the raw
        // input: a pattern like `link/../x.pdf` folds to `root/x.pdf` here, so
        // a symlink component can never be re-introduced between check and
        // write via a `..` that lexically folded away.
        Ok(validated) => Ok(validated),
        Err(_) => Err(AppError::InvalidInput(
            "export output path escapes the workspace".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::sanitize_file_stem;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        super::BatchExportItem::export(&cfg).unwrap();
        super::BatchExportOutcome::export(&cfg).unwrap();
    }

    #[test]
    fn sanitize_file_stem_strips_path_hops_and_unsafe_chars() {
        assert_eq!(sanitize_file_stem("chapter 1"), "chapter 1");
        // Path separators become underscores; leading dots are trimmed so the
        // stem can never be a `..` traversal component.
        assert_eq!(sanitize_file_stem("..\\..\\evil"), "_.._evil");
        assert_eq!(sanitize_file_stem("a/b\\c:d"), "a_b_c_d");
        assert_eq!(sanitize_file_stem("..."), "document");
        assert_eq!(sanitize_file_stem("  "), "document");
        // CJK file names survive as-is (alphanumeric covers them).
        assert_eq!(sanitize_file_stem("第三章"), "第三章");
    }

    /// The containment policy `ensure_export_within_workspace` applies, as a
    /// bool for assertions (production calls `ensure_contained_path`
    /// directly; the wrapper anchors relative candidates at the root exactly
    /// like the production call site does).
    fn within_workspace(root: &Path, target: &Path) -> bool {
        let abs = if target.is_absolute() {
            target.to_path_buf()
        } else {
            root.join(target)
        };
        crate::domain::path::ensure_contained_path(root, &abs).is_ok()
    }

    /// A real temp dir (so `canonicalize` inside `ensure_contained_path`
    /// succeeds), already created on disk.
    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn within_workspace_accepts_nested_and_rejects_escape() {
        let root = tmp_root();
        // Nested + relative (joined under root).
        assert!(within_workspace(&root, &root.join("build/x.pdf")));
        assert!(within_workspace(&root, &root.join("a/b/c.typ")));
        assert!(within_workspace(&root, Path::new("build/x.pdf")));
        // `..` that stays under root.
        assert!(within_workspace(&root, &root.join("a/../b.typ")));
        // Escapes.
        assert!(!within_workspace(&root, &root.join("../etc/passwd")));
        assert!(!within_workspace(&root, &root.join("../../evil")));
        // Absolute path outside root.
        let outside = std::env::temp_dir().join("totally-outside.pdf");
        assert!(!within_workspace(&root, &outside));
    }

    #[cfg(unix)]
    #[test]
    fn within_workspace_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tmp_root();
        let outside = std::env::temp_dir().join(format!("typst-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        // A repo-shipped symlink `build -> outside` must NOT let a write escape.
        symlink(&outside, root.join("build")).unwrap();
        assert!(!within_workspace(&root, &root.join("build/evil.pdf")));
        // A plain (non-symlink) descendant is still fine.
        std::fs::create_dir_all(root.join("safe")).unwrap();
        assert!(within_workspace(&root, &root.join("safe/ok.pdf")));
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// Regression: a DANGLING symlink under the root (`evil.pdf -> <missing>`
    /// outside the workspace) has `exists() == false`, so the old exists()-based
    /// ancestor walk treated it as a missing tail and passed the check; the
    /// subsequent `std::fs::write` followed the link and created the file
    /// OUTSIDE the workspace. The symlink_metadata-based containment must
    /// reject it.
    #[cfg(unix)]
    #[test]
    fn within_workspace_rejects_dangling_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tmp_root();
        let target =
            std::env::temp_dir().join(format!("typst-dangling-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("build")).unwrap();
        symlink(&target, root.join("build/evil.pdf")).unwrap();
        // Precondition: the link is dangling (target absent), so `exists()`
        // lies — this is exactly the input shape the old walk mishandled.
        assert!(!root.join("build/evil.pdf").exists());
        assert!(!within_workspace(&root, &root.join("build/evil.pdf")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Windows variant of the dangling-link regression, best-effort: creating a
    /// file symlink needs Developer Mode / admin privileges, so the test skips
    /// silently when the OS refuses. The logic itself is covered on Unix CI.
    #[cfg(windows)]
    #[test]
    fn within_workspace_rejects_dangling_symlink_escape_windows() {
        let root = tmp_root();
        std::fs::create_dir_all(root.join("build")).unwrap();
        let target = std::env::temp_dir().join("typst-dangling-missing.pdf");
        if std::os::windows::fs::symlink_file(&target, root.join("build/evil.pdf")).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        assert!(!root.join("build/evil.pdf").exists());
        assert!(!within_workspace(&root, &root.join("build/evil.pdf")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn within_workspace_handles_windows_paths() {
        let root = tmp_root();
        let root_str = root.to_string_lossy().to_string();
        // Case-variant absolute path (the canonicalized prefix match tolerates it).
        let lower = root_str.to_ascii_lowercase();
        assert!(within_workspace(&root, Path::new(&format!("{lower}\\build\\x.pdf"))));
        assert!(within_workspace(&root, Path::new("build\\x.pdf")));
        assert!(!within_workspace(&root, &root.join("..\\evil.pdf")));
    }
}
