//! Git IPC commands (§Source Control). All wrap gix work in `spawn_blocking`
//! because `gix::Repository` is `Send` but not `Sync` — every command
//! re-discovers the repo from the workspace root.

use crate::domain::git_status::{CommitLog, GitFileStatus};
use crate::error::AppError;
use crate::ipc::state::AppState;
use tauri::State;

fn no_workspace() -> AppError {
    AppError::Other("no workspace open".into())
}

/// Collect the workspace's git status. Returns `Ok(None)` when the workspace is
/// not inside a git repository (the UI shows a friendly empty state).
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<Option<Vec<GitFileStatus>>, AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::status::collect_status(&root)
            .map_err(|e| AppError::Other(format!("git status failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Stage a single file (`git add <path>`).
#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::stage(&root, &path)
            .map_err(|e| AppError::Other(format!("git stage failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Unstage a single file (`git reset HEAD <path>`).
#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::unstage(&root, &path)
            .map_err(|e| AppError::Other(format!("git unstage failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Create a commit with `message`. Returns the new commit's hex id.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    message: String,
) -> Result<String, AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::commit(&root, &message)
            .map_err(|e| AppError::Other(format!("git commit failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Recent commit log (first-parent walk from HEAD). `limit` defaults to 50.
#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<CommitLog>, AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    let n = limit.unwrap_or(50);
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::log(&root, n)
            .map_err(|e| AppError::Other(format!("git log failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}
