//! Network-related Tauri commands.
//!
//! Thin adapter over [`HttpClient::fetch_to_file`](crate::net::client::HttpClient):
//! argument conversion + a containment guard on `dest`, then delegation to the
//! shared [`AppState`](crate::ipc::state::AppState) client.

use tauri::State;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::net::client::FetchOptions;

/// Download `url` to `dest` (an absolute filesystem path). Returns the number
/// of bytes written. Used by the paste feature to materialize remote images
/// for `#image()` resolution.
///
/// **Containment:** see [`ensure_paste_dest`](crate::ipc::ensure_paste_dest) —
/// `dest` must live under the open workspace root or the app's config
/// directory. The URL scheme is enforced http(s)-only by
/// [`HttpClient`](crate::net::client::HttpClient) itself.
#[tauri::command]
pub async fn fetch_url_to_file(
    url: String,
    dest: String,
    state: State<'_, AppState>,
) -> Result<u64> {
    let dest_path = crate::ipc::ensure_paste_dest(&state, &dest)?.to_path_buf();
    state
        .net
        .fetch_to_file(&url, &dest_path, &FetchOptions::default())
        .await
        .map_err(AppError::from)
}
