//! Startup fault-tolerance (§6.5).
//!
//! Goal: a single component failure (config dir, settings, session) must NEVER
//! prevent the main window from appearing. Instead the setup closure collects
//! [`StartupProblem`]s and emits them once at the end so the frontend can show
//! a non-modal banner.
//!
//! The settings and session services are *already* load-tolerant (corrupt /
//! missing files degrade to an empty store — see [`JsonFileStore::load_value`]
//! and [`SessionService::load`]). The new fault-tolerance wraps the remaining
//! `?` propagation points:
//!
//! - `app_config_dir()` — if the platform config dir can't be resolved, fall
//!   back to a process-local temp dir (nothing persists, but the app boots).
//! - `SettingsService::new(..)?` — already near-unfailing, but guard it so a
//!   future regression surfaces as a problem, not a crash.
//! - `SessionService::load(..)?` — same.
//!
//! The decision helpers ([`load_or_problem`], [`config_dir_or_problem`]) are
//! pure and unit-tested; the setup closure is a thin caller.

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// A single non-fatal failure observed during startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct StartupProblem {
    /// The component that failed (e.g. `"config_dir"`, `"settings"`, `"session"`).
    pub component: String,
    /// A short human-readable message (no document text — §7.4).
    pub message: String,
}

/// Payload of the `startup_problems` event (§6.5). Emitted once at end of
/// setup only when `problems` is non-empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct StartupProblemsPayload {
    pub problems: Vec<StartupProblem>,
}

/// Fall back gracefully: run `f`, and on `Err` record a `StartupProblem` and
/// invoke `fallback`. The result is always the fallback value — setup never
/// propagates these errors.
pub fn load_or_problem<T, F>(
    component: &str,
    f: F,
    fallback: impl FnOnce() -> T,
    problems: &mut Vec<StartupProblem>,
) -> T
where
    F: FnOnce() -> Result<T>,
{
    match f() {
        Ok(v) => v,
        Err(e) => {
            let message = e.to_string();
            tracing::warn!(component, error = %message, "startup component degraded");
            problems.push(StartupProblem {
                component: component.to_string(),
                message,
            });
            fallback()
        }
    }
}

/// Resolve the config dir, falling back to a temp dir if the platform path
/// can't be obtained. Records a problem on fallback so the user knows settings
/// won't persist this session.
///
/// Takes the already-stringified error message rather than a generic
/// `Result<_, E: Display>`: a generic `E` is left unconstrained when the caller
/// passes an `Ok` value, which on macOS triggers a rustc trait-resolution
/// recursion overflow (the compiler tries to prove `E: Display` for every
/// reachable type, including `objc2::Retained`, ad infinitum). The caller
/// converts its platform error to a `String` before calling.
pub fn config_dir_or_problem(
    resolved: std::result::Result<std::path::PathBuf, String>,
    problems: &mut Vec<StartupProblem>,
) -> std::path::PathBuf {
    match resolved {
        Ok(dir) => dir,
        Err(message) => {
            let full = format!("config dir unavailable, using temp: {message}");
            tracing::warn!(error = %full, "config dir unavailable, using temp");
            problems.push(StartupProblem {
                component: "config_dir".to_string(),
                message: full,
            });
            // A process-local temp dir: settings/session won't survive a
            // restart, but the app boots.
            std::env::temp_dir().join("typst-studio-fallback")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::path::PathBuf;

    #[test]
    fn load_or_problem_uses_value_on_success() {
        let mut problems = Vec::new();
        let v: i32 = load_or_problem("x", || Ok(42), || 0, &mut problems);
        assert_eq!(v, 42);
        assert!(problems.is_empty());
    }

    #[test]
    fn load_or_problem_falls_back_and_records_on_error() {
        let mut problems = Vec::new();
        let v: i32 = load_or_problem(
            "settings",
            || Err(AppError::Other("boom".into())),
            || 7,
            &mut problems,
        );
        assert_eq!(v, 7);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].component, "settings");
        assert!(problems[0].message.contains("boom"));
    }

    #[test]
    fn config_dir_uses_resolved_path() {
        let mut problems = Vec::new();
        let dir = config_dir_or_problem(Ok(PathBuf::from("/x/y")), &mut problems);
        assert_eq!(dir, PathBuf::from("/x/y"));
        assert!(problems.is_empty());
    }

    #[test]
    fn config_dir_falls_back_and_records_problem() {
        let mut problems = Vec::new();
        let dir = config_dir_or_problem(
            Err::<PathBuf, String>("permission denied".into()),
            &mut problems,
        );
        assert!(dir.to_string_lossy().contains("fallback"), "got {dir:?}");
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].component, "config_dir");
    }

    #[test]
    fn startup_problem_serializes_cleanly() {
        // Verify the wire format the frontend will read.
        let p = StartupProblem {
            component: "settings".into(),
            message: "boom".into(),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"component\""));
        assert!(json.contains("\"message\""));
    }
}
