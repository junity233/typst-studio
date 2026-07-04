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
use crate::domain::document::DocumentId;
use crate::error::{AppError, Result};
use crate::ipc::events::{LspStatusPayload, OpenedDocument};
use crate::ipc::state::AppState;

/// Create a new untitled tab. `content` defaults to the built-in template.
/// The initial compile is spawned asynchronously — this returns immediately.
#[tauri::command]
pub async fn new_tab(state: State<'_, AppState>, content: Option<String>) -> Result<OpenedDocument> {
    let editor = state.editor.clone();
    let meta = editor.new_tab(content);
    let content_text = editor.tab_text(meta.id).unwrap_or_default();
    Ok(OpenedDocument {
        meta,
        content: content_text,
    })
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
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("Typst", &["typ"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = path_buf_from(picked)?;
    // Read file on a blocking thread (large files shouldn't stall the async runtime).
    let path_for_read = path.clone();
    let content = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path_for_read)
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    let editor = state.editor.clone();
    let meta = editor.open_from_content(path, content.clone(), Some(&state.workspace))?;
    Ok(Some(OpenedDocument { meta, content }))
}

/// Close a tab, releasing its world and caches.
#[tauri::command]
pub async fn close_tab(state: State<'_, AppState>, id: DocumentId) -> Result<()> {
    state.editor.close_tab(id)
}

/// Update a tab's source text and schedule a 300ms debounced compile.
#[tauri::command]
pub async fn update_text(
    state: State<'_, AppState>,
    id: DocumentId,
    content: String,
) -> Result<()> {
    state.editor.update_text(id, content)
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
) -> Result<String> {
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
    let path = path_buf_from(picked)?;
    let path_str = path.to_string_lossy().to_string();
    let export = state.export.clone();
    // Render (CPU-bound) + write (blocking IO) together on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let bytes = export.render_pdf(id, revision)?;
        std::fs::write(&path, &bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    Ok(path_str)
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
) -> Result<Vec<String>> {
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
    let picked_path = path_buf_from(picked)?;
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
    let base_name_clone = base_name.clone();
    // Render (CPU-bound) + write (blocking IO) together on a blocking thread.
    let paths = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let pages = export.render_pngs(id, revision, &base_name_clone)?;
        std::fs::create_dir_all(&save_dir)?;
        let mut written = Vec::with_capacity(pages.len());
        for (name, bytes) in pages {
            let full = save_dir.join(&name);
            std::fs::write(&full, &bytes)?;
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
) -> Result<Vec<String>> {
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
    let picked_path = path_buf_from(picked)?;
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
    let base_name_clone = base_name.clone();
    // Render (CPU-bound) + write (blocking IO) together on a blocking thread.
    let paths = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let pages = export.render_svgs(id, revision, &base_name_clone)?;
        std::fs::create_dir_all(&save_dir)?;
        let mut written = Vec::with_capacity(pages.len());
        for (name, bytes) in pages {
            let full = save_dir.join(&name);
            std::fs::write(&full, &bytes)?;
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

/// Convert a dialog `FilePath` into a `PathBuf`, rejecting URLs we can't resolve.
fn path_buf_from(picked: tauri_plugin_fs::FilePath) -> Result<PathBuf> {
    picked
        .into_path()
        .map_err(|e| AppError::InvalidInput(format!("invalid file path: {e}")))
}
