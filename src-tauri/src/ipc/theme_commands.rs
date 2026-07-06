//! Theme Tauri commands.
//!
//! Thin adapters over [`ThemeService`](crate::service::theme_service::ThemeService),
//! following the same shape as `settings_commands`: async `#[tauri::command]`
//! fns taking `State<'_, AppState>` and returning `crate::error::Result<T>`.

use tauri::{AppHandle, State};

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::service::theme_service::ThemeInfo;

/// List the available themes: compiled-in built-ins first (in their defined
/// order), then any user themes on disk that don't shadow a built-in. A user
/// theme with the same id as a built-in overrides the built-in's metadata. The
/// implicit built-in `default` is prepended on the frontend side only.
#[tauri::command]
pub async fn list_themes(state: State<'_, AppState>) -> Result<Vec<ThemeInfo>> {
    Ok(state.themes.list())
}

/// Read the CSS source for one theme. Returns `None` for the built-in default
/// theme or any unreadable/unknown id (the frontend falls back to default).
#[tauri::command]
pub async fn get_theme_css(id: String, state: State<'_, AppState>) -> Result<Option<String>> {
    Ok(state.themes.css_for(&id))
}

/// Open the user themes directory in the OS file manager so the user can
/// create/edit theme folders. Resolves the path from the `ThemeService`,
/// ensures it exists, and reveals it via the opener plugin. Returns the
/// resolved directory path as a string so the frontend can show it.
#[tauri::command]
pub async fn open_themes_dir(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.themes.themes_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}
