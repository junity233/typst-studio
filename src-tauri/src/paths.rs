//! Pure (no-Tauri) resolution of well-known platform directories.
//!
//! These helpers exist because some Tauri hooks run BEFORE `.setup`, where
//! `app.path()` is not yet usable (`PathResolver` is `manage`d only as part of
//! `.build()`, after which `.setup` runs). The native menu builder is one such
//! hook — it builds "Open Recent" from `session.json` at `.build()` time and
//! needs the config dir without an `AppHandle`. The helpers here mirror the
//! paths `app.path().app_config_dir()` / `app.path().app_log_dir()` would
//! return, derived from environment variables so they work from any context
//! (including tests).
//!
//! Keep these in sync with `tauri.conf.json`'s `identifier`
//! (`com.typststudio.app`); a change there must be reflected here and in
//! [`diagnostics`](crate::diagnostics).

use std::path::PathBuf;

/// The bundle identifier used to namespace per-app platform directories.
/// Mirrors `tauri.conf.json`'s `identifier`.
const APP_IDENTIFIER: &str = "com.typststudio.app";

/// Manual resolution of `app.path().app_config_dir()` without an `AppHandle`.
///
/// Returns the platform-standard config directory for this app:
/// - macOS: `~/Library/Application Support/<id>`
/// - Linux: `$XDG_CONFIG_HOME/<id>` (or `~/.config/<id>`)
/// - Windows: `%APPDATA%/<id>`
///
/// Returns `None` if the underlying env var is unset (rare; the caller falls
/// back to an empty list / temp dir).
pub fn app_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join("Library/Application Support").join(APP_IDENTIFIER))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join(APP_IDENTIFIER))
    }
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join(APP_IDENTIFIER))
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_is_namespaced_under_identifier() {
        // Smoke test: resolution succeeds on a dev machine where the env vars
        // are set, and the result always ends with the app identifier. We
        // don't assert the full path (it varies by platform/CI env).
        if let Some(dir) = app_config_dir() {
            assert!(
                dir.ends_with(APP_IDENTIFIER),
                "config dir should end with the app identifier, got {dir:?}"
            );
        }
    }
}
