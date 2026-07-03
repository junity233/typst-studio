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

use crate::error::{AppError, Result};
use crate::fs::tree::EntryKind;
use crate::fs::watcher;
use crate::ipc::events::{FsChangedPayload, OpenedDocument};
use crate::ipc::state::AppState;
use crate::service::workspace_service::WorkspaceMeta;

/// Open `root` as the workspace (set root + resolver, start the watcher). Shared
/// by the dialog picker and the default-workspace (cwd) opener. Builds the
/// `fs_changed` emitter callback.
fn open_path_as_workspace(
    app: &AppHandle,
    workspace: &std::sync::Arc<crate::service::workspace_service::WorkspaceService>,
    root: PathBuf,
) -> Result<WorkspaceMeta> {
    let app_for_cb = app.clone();
    let on_change: watcher::OnChange = Arc::new(move |paths: &[PathBuf]| {
        let payload = FsChangedPayload {
            paths: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        };
        let _ = app_for_cb.emit("fs_changed", payload);
    });
    workspace.open(root, on_change)
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

    let meta = open_path_as_workspace(&app, &state.workspace, root)?;
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
    let meta = open_path_as_workspace(&app, &state.workspace, cwd)?;
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
    let meta = open_path_as_workspace(&app, &state.workspace, root)?;
    Ok(Some(meta))
}

/// Close the current workspace (stops the watcher; open tabs are untouched).
#[tauri::command]
pub async fn close_workspace(state: State<'_, AppState>) -> Result<()> {
    state.workspace.close();
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
#[tauri::command]
pub async fn rename_entry(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<()> {
    let ws = state.workspace.clone();
    ws.rename_entry(&from, &to)
}

/// Delete a workspace-relative file or directory.
#[tauri::command]
pub async fn delete_entry(state: State<'_, AppState>, rel: String) -> Result<()> {
    let ws = state.workspace.clone();
    ws.delete_entry(&rel)
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
    // resolver-anchored world accordingly — no resolver argument needed here.
    let editor = state.editor.clone();
    let meta = editor.open_from_disk(path, content.clone())?;
    Ok(OpenedDocument { meta, content })
}

/// Save As: write a tab's text to a new file chosen via a save dialog, then
/// make the tab file-backed at that path. Used for untitled tabs (and to save a
/// file elsewhere). Returns the new path.
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
        return Err(AppError::Other("save cancelled".into()));
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::InvalidInput(format!("invalid file path: {e}")))?;
    let path_for_write = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path_for_write, &text))
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))??;
    editor.rebind_path(id, path.clone())?;
    Ok(path.to_string_lossy().into_owned())
}
