//! Network-related Tauri commands.
//!
//! Thin adapter over [`HttpClient::fetch_to_file`](crate::net::client::HttpClient):
//! argument conversion + an absolute-path guard on `dest`, then delegation to
//! the shared [`AppState`](crate::ipc::state::AppState) client.

use std::path::Path;

use tauri::State;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::net::client::FetchOptions;

/// Download `url` to `dest` (an absolute filesystem path). Returns the number
/// of bytes written. Used by the paste feature to materialize remote images
/// for `#image()` resolution.
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
    state
        .net
        .fetch_to_file(&url, dest_path, &FetchOptions::default())
        .await
        .map_err(AppError::from)
}
