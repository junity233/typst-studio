//! Settings Tauri commands.
//!
//! Thin adapters over [`SettingsService`](crate::settings::SettingsService),
//! following the same shape as [`fs_commands`](crate::ipc::fs_commands): async
//! `#[tauri::command]` fns taking `State<'_, AppState>` and returning
//! `crate::error::Result<T>`.

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::lsp::manager::LspRestartReason;
use crate::settings::{window, Manifest};

/// The settings-key prefix reserved for initialize-time LSP settings (spec §18:
/// "仅 initialize-time LSP settings 变更触发 restart"). A change to ANY key
/// under this prefix requires restarting tinymist, because such values are sent
/// only in the `initialize` payload and cannot be re-applied to a running
/// server via `workspace/didChangeConfiguration`.
///
/// NOTE: no `lsp.*` key exists in the manifest yet (forward-looking hook per
/// Task 8 part B). Until one is added this branch is never taken; the hook is
/// in place so the day an `lsp.*` setting lands, the restart is automatic.
const LSP_SETTING_PREFIX: &str = "lsp.";

/// Pure decision helper for §18: whether a setting change at `key` should
/// trigger an LSP restart. Returns `true` iff `key` starts with `lsp.` (an
/// initialize-time LSP setting). Extracted as a free function so the §18
/// "only initialize-time LSP settings trigger restart" contract is
/// unit-testable without a live LSP listener or a populated manifest.
pub(crate) fn should_restart_for_setting(key: &str) -> bool {
    key.starts_with(LSP_SETTING_PREFIX)
}

/// Return the full runtime config document.
#[tauri::command]
pub async fn get_all_settings(state: State<'_, AppState>) -> Result<Value> {
    Ok(state.settings.get_all())
}

/// Read a single value. When `default` is omitted the manifest default for
/// `path` is used.
#[tauri::command]
pub async fn get_setting(
    path: String,
    default: Option<Value>,
    state: State<'_, AppState>,
) -> Result<Value> {
    Ok(match default {
        Some(d) => state.settings.get::<Value>(&path, d),
        None => state.settings.get_or_default::<Value>(&path),
    })
}

/// Validate, persist, and broadcast a single value (`settings_changed`).
#[tauri::command]
pub async fn set_setting(
    path: String,
    value: Value,
    state: State<'_, AppState>,
) -> Result<()> {
    state.settings.set(&path, value)?;
    // §18: only initialize-time LSP settings (`lsp.*`) require restarting
    // tinymist — they ride in the `initialize` payload and can't be re-applied
    // to a running server. No such setting exists in the manifest yet, so this
    // branch is dormant; the hook is here so the day one lands the restart is
    // automatic. Non-LSP settings (editor.*, compiler.*, …) never restart.
    if should_restart_for_setting(&path) {
        state.lsp.request_restart(LspRestartReason::SettingsChange);
    }
    Ok(())
}

/// Return a clone of the embedded manifest so the frontend can render controls.
#[tauri::command]
pub async fn get_settings_manifest(state: State<'_, AppState>) -> Result<Manifest> {
    Ok(state.settings.manifest().clone())
}

/// Open (or focus) the standalone Settings window.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<()> {
    window::open_or_focus(&app)
}

/// Open the diagnostic log directory in the OS file manager (§7.4 "打开日志目录").
/// Resolves `app.path().app_log_dir()` and reveals it via the opener plugin.
/// Returns the resolved directory path as a string so the frontend can show it.
#[tauri::command]
pub async fn open_log_dir(app: AppHandle) -> Result<String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Other(format!("resolve app_log_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Open the WebView2/WebKit devtools (F12 console) on the main editor window.
///
/// Requires the `devtools` Tauri feature (enabled in `Cargo.toml`); without it
/// `open_devtools` is a no-op on release Windows builds. Provided as a Settings
/// action so users can self-diagnose rendering/IPC issues in shipped builds
/// without keyboard accelerators (which are also gated on devtools).
#[tauri::command]
pub async fn open_devtools(app: AppHandle) -> Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(AppError::Other(
            "main window not found; devtools can only open on a live webview".into(),
        ));
    };
    window.open_devtools();
    Ok(())
}

/// List the available font families (embedded + system + extra dirs) for the
/// Settings font picker. Drawn from the process-wide warmed `FontStore`, so it
/// matches exactly what the compiler can resolve. Returns the names in display
/// case, sorted and deduped. The list is the same for every call within a
/// process (changing extra font dirs needs an app restart), so the frontend
/// caches the result for the window's lifetime.
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<String>> {
    Ok(crate::typst_engine::font_loader::list_families())
}

/// Open a native folder/file picker and return the chosen absolute path as a
/// string, or `None` if the user cancelled. `kind` selects the dialog:
/// `"folder"` (default for unknown values) opens a folder picker, anything else
/// opens a file picker.
///
/// Implemented as a Rust command (not the frontend dialog plugin) because the
/// settings window deliberately grants no `dialog:default` capability — its
/// blast radius is intentionally minimal. The Rust `DialogExt` path bypasses
/// the frontend permission gate, exactly like `open_log_dir` / `open_themes_dir`
/// use `app.opener()`. The blocking dialog runs on `spawn_blocking` so it
/// doesn't stall the webview (mirrors `pick_image_file` / `open_workspace`).
#[tauri::command]
pub async fn pick_path(app: AppHandle, kind: String) -> Result<Option<String>> {
    use crate::ipc::commands::path_buf_from;
    use tauri_plugin_dialog::DialogExt;
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app_for_dialog.dialog().file();
        if kind == "folder" {
            dialog.blocking_pick_folder()
        } else {
            dialog.blocking_pick_file()
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    match picked {
        None => Ok(None),
        Some(file_path) => {
            let path = path_buf_from(file_path)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::should_restart_for_setting;

    #[test]
    fn lsp_prefixed_key_triggers_restart() {
        // §18: any `lsp.*` (initialize-time LSP) setting change restarts.
        assert!(should_restart_for_setting("lsp.format"));
        assert!(should_restart_for_setting("lsp.diagnostics"));
        assert!(should_restart_for_setting("lsp.some.deeply.nested.key"));
    }

    #[test]
    fn non_lsp_setting_does_not_restart() {
        // Editor / compiler / theme settings are NOT initialize-time LSP
        // settings — they apply without restarting tinymist.
        assert!(!should_restart_for_setting("editor.fontSize"));
        assert!(!should_restart_for_setting("compiler.foo"));
        assert!(!should_restart_for_setting("theme.name"));
        assert!(!should_restart_for_setting("window.width"));
    }

    #[test]
    fn near_match_not_prefixed_does_not_restart() {
        // A key that merely CONTAINS "lsp" but isn't under the `lsp.` prefix
        // must NOT trigger a restart (e.g. a future `editor.lspVerbosity`).
        assert!(!should_restart_for_setting("editor.lspVerbosity"));
        assert!(!should_restart_for_setting("lsp")); // exactly "lsp", no dot
        assert!(!should_restart_for_setting(""));
    }
}
