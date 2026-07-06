//! Network-related Tauri commands.
//!
//! Thin adapter over [`HttpClient::fetch_to_file`](crate::net::client::HttpClient):
//! argument conversion + a containment guard on `dest`, then delegation to the
//! shared [`AppState`](crate::ipc::state::AppState) client.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::net::client::FetchOptions;

/// Lexically normalize `path` (resolving `..`/`.` without touching the
/// filesystem, since the target may not exist yet) and return `true` if the
/// result is contained within `base`. Symlinks are NOT followed: a pasted
/// image's destination is always a freshly-invented path under a known root,
/// so lexical containment is both sufficient and safe (no TOCTOU).
fn is_contained(path: &Path, base: &Path) -> bool {
    let normalized = normalize_lexically(path);
    normalized.starts_with(base)
}

/// Lexical normalization (`./` and `../` collapsed) without filesystem access.
/// Mirrors the helper in `workspace_service`; duplicated here to keep the net
/// layer dependency-free.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        use std::path::Component;
        match comp {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
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
