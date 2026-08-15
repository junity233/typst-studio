//! Git IPC commands (§Source Control). All wrap gix work in `spawn_blocking`
//! because `gix::Repository` is `Send` but not `Sync` — every command
//! re-discovers the repo from the workspace root.

use crate::domain::git_status::{CommitLog, GitFileStatus};
use crate::error::AppError;
use crate::ipc::state::AppState;
use std::path::Path;
use tauri::State;

fn no_workspace() -> AppError {
    AppError::Other("no workspace open".into())
}

/// Shared tail of the git commands: resolve the workspace root, then run the
/// gix operation on the blocking pool. `label` names the operation in error
/// messages (`"git {label} failed: …"`).
async fn run_git<T, F>(state: &State<'_, AppState>, label: &'static str, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> anyhow::Result<T> + Send + 'static,
{
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        f(&root).map_err(|e| AppError::Other(format!("git {label} failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Collect the workspace's git status. Returns `Ok(None)` when the workspace is
/// not inside a git repository (the UI shows a friendly empty state).
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<Option<Vec<GitFileStatus>>, AppError> {
    run_git(&state, "status", crate::git::status::collect_status).await
}

/// Stage a single file (`git add <path>`).
#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    run_git(&state, "stage", move |root| {
        crate::git::operations::stage(root, &path)
    })
    .await
}

/// Unstage a single file (`git reset HEAD <path>`).
#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    run_git(&state, "unstage", move |root| {
        crate::git::operations::unstage(root, &path)
    })
    .await
}

/// Create a commit with `message`. Returns the new commit's hex id.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    message: String,
) -> Result<String, AppError> {
    run_git(&state, "commit", move |root| {
        crate::git::operations::commit(root, &message)
    })
    .await
}

/// Recent commit log (first-parent walk from HEAD). `limit` defaults to 50.
#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<CommitLog>, AppError> {
    let n = limit.unwrap_or(50);
    run_git(&state, "log", move |root| crate::git::operations::log(root, n)).await
}
