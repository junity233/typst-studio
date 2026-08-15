//! IPC layer — thin Tauri command/event wrappers.
//!
//! Commands intentionally only do parameter conversion and delegate to services.

pub mod commands;
pub mod dialog;
pub mod ai_commands;
pub mod bib_commands;
pub mod conflict_commands;
pub mod error;
pub mod events;
pub mod formula_commands;
pub mod fs_commands;
pub mod git_commands;
pub mod menu;
pub mod menu_labels;
pub mod net_commands;
pub mod package_commands;
pub mod project_config_commands;
pub mod recovery_commands;
pub mod session_commands;
pub mod settings_commands;
pub mod theme_commands;
pub mod state;

use std::path::Path;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;

/// Shared containment guard for app-initiated writes whose destination the
/// frontend computes (pasted images: `write_bytes_to_file`,
/// `fetch_url_to_file`). `dest` must be an absolute path under the open
/// workspace root or the app config dir — the only two legitimate targets for
/// a pasted image — so a compromised/XSSed frontend can't write to `~/.ssh/`,
/// a sibling document, or any arbitrary absolute path. Containment resolves
/// every existing ancestor, so a symlinked directory can't redirect the write
/// outside an allow-listed root. Returns the parsed path on success.
pub(crate) fn ensure_paste_dest<'a>(state: &AppState, dest: &'a str) -> Result<&'a Path> {
    let dest_path = Path::new(dest);
    if !dest_path.is_absolute() {
        return Err(AppError::InvalidInput("dest must be absolute".into()));
    }
    let workspace_root = state.workspace.root();
    let config_base = crate::paths::app_config_dir();
    let allowed = workspace_root
        .as_ref()
        .map(|r| crate::domain::path::ensure_contained_path(r, dest_path).is_ok())
        .unwrap_or(false)
        || config_base
            .as_ref()
            .map(|b| crate::domain::path::ensure_contained_path(b, dest_path).is_ok())
            .unwrap_or(false);
    if !allowed {
        return Err(AppError::InvalidInput(
            "dest must be inside the workspace or the app config directory".into(),
        ));
    }
    Ok(dest_path)
}
