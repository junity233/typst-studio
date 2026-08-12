//! Project config (`.typstpro`) Tauri commands.
//!
//! Thin adapters over
//! [`ProjectConfigService`](crate::service::project_config_service), following
//! the same shape as [`settings_commands`](crate::ipc::settings_commands): async
//! `#[tauri::command]` fns taking `State<'_, AppState>` and returning
//! `crate::error::Result<T>`. Each mutator resolves the workspace root from the
//! open workspace, returning [`AppError::Other`] when none is open.

use tauri::State;

use crate::domain::project_config::ProjectConfig;
use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::service::project_config_service::CONFIG_FILENAME;

/// "no workspace open" error for project-config mutators that need a root.
fn no_workspace() -> AppError {
    AppError::Other("no workspace open".into())
}

/// The cached project config, or `None` (no workspace, or no `.typstpro`).
#[tauri::command]
pub async fn get_project_config(state: State<'_, AppState>) -> Result<Option<ProjectConfig>> {
    Ok(state.project_config.get())
}

/// Validate, persist, cache, and broadcast a full config (`project_config_changed`).
/// Requires an open workspace (the file is written to its root).
#[tauri::command]
pub async fn set_project_config(
    config: ProjectConfig,
    state: State<'_, AppState>,
) -> Result<ProjectConfig> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    state.project_config.set(&root, config)
}

/// Set (or clear, when `path` is `None`) the main compile file. Other fields of
/// any existing `.typstpro` are preserved.
#[tauri::command]
pub async fn set_main_file(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<ProjectConfig> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    state.project_config.set_main_file(&root, path)
}

/// Delete the workspace's `.typstpro` and clear the cache (`project_config_changed(None)`).
#[tauri::command]
pub async fn clear_project_config(state: State<'_, AppState>) -> Result<()> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    state.project_config.clear(&root)
}

/// Absolute path to the workspace's `.typstpro` (whether or not it exists), or
/// `None` when no workspace is open. Lets the panel show "no config yet" vs.
/// "exists" without a stat round-trip.
#[tauri::command]
pub async fn get_project_config_path(state: State<'_, AppState>) -> Result<Option<String>> {
    Ok(state
        .workspace
        .root()
        .map(|root| root.join(CONFIG_FILENAME).to_string_lossy().into_owned()))
}

/// All `.typ` files under the workspace root (workspace-relative, forward
/// slashes, sorted), for the main-file picker. Applies the project's `exclude`
/// globs. Empty when no workspace is open. The recursive directory walk is
/// offloaded to `spawn_blocking` so it can't stall the async runtime on large
/// workspaces (mirrors `search_workspace`).
#[tauri::command]
pub async fn list_typ_files(state: State<'_, AppState>) -> Result<Vec<String>> {
    let root = state.workspace.root();
    let root = match root {
        Some(r) => r,
        None => return Ok(Vec::new()),
    };
    let exclude = state
        .project_config
        .get()
        .and_then(|cfg| cfg.exclude)
        .map(|v| build_exclude_set(&v));
    let files = tauri::async_runtime::spawn_blocking(move || {
        crate::service::project_config_service::ProjectConfigService::list_typ_files(
            &root,
            exclude.as_ref(),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    Ok(files)
}

/// Build the exclude GlobSet once (cheap) so the spawned walk threads a single
/// reference through.
fn build_exclude_set(patterns: &[String]) -> globset::GlobSet {
    crate::service::project_config_service::build_exclude_globset(Some(patterns))
        .unwrap_or_else(|| globset::GlobSet::empty())
}
