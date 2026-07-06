//! Network-related Tauri commands.
//!
//! Thin adapter over [`HttpClient::fetch_to_file`](crate::net::client::HttpClient):
//! argument conversion + a containment guard on `dest`, then delegation to the
//! shared [`AppState`](crate::ipc::state::AppState) client.

use std::path::Path;

use tauri::State;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::net::client::FetchOptions;

/// Return whether `path` is contained within `base`, resolving every existing
/// ancestor so a symlinked directory cannot redirect the write outside the
/// allow-listed root. Missing trailing components remain supported.
fn is_contained(path: &Path, base: &Path) -> bool {
    crate::domain::path::ensure_contained_path(base, path).is_ok()
}

/// Download `url` to `dest` (an absolute filesystem path). Returns the number
/// of bytes written. Used by the paste feature to materialize remote images
/// for `#image()` resolution.
///
/// **Containment:** `dest` must live under either the open workspace root or
/// the app's config directory (the only two legitimate targets for a pasted
/// image — a workspace-relative `assets/` dir, or the per-user image cache for
/// an untitled tab). Anything else is rejected so a compromised/XSSed page
/// can't use this command to write to `~/.ssh/`, a sibling document, or any
/// arbitrary absolute path. The URL scheme is enforced http(s)-only by
/// [`HttpClient`](crate::net::client::HttpClient) itself.
#[tauri::command]
pub async fn fetch_url_to_file(
    url: String,
    dest: String,
    state: State<'_, AppState>,
) -> Result<u64> {
    let dest_path = Path::new(&dest);
    if !dest_path.is_absolute() {
        return Err(AppError::InvalidInput("dest must be absolute".into()));
    }
    // Resolve the allow-listed bases. Workspace root when a folder is open;
    // app config dir always (covers the untitled-tab image-cache case).
    let workspace_root = state.workspace.root();
    let config_base = crate::paths::app_config_dir();
    let allowed = workspace_root
        .as_ref()
        .map(|r| is_contained(dest_path, r))
        .unwrap_or(false)
        || config_base
            .as_ref()
            .map(|b| is_contained(dest_path, b))
            .unwrap_or(false);
    if !allowed {
        return Err(AppError::InvalidInput(
            "dest must be inside the workspace or the app config directory".into(),
        ));
    }
    state
        .net
        .fetch_to_file(&url, dest_path, &FetchOptions::default())
        .await
        .map_err(AppError::from)
}
