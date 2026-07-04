//! Diagnostic log wiring (§7.4).
//!
//! Two-phase subscriber initialization:
//!
//! 1. **Phase 1 (early, in `run()` before the Tauri builder):** a minimal
//!    stderr-only subscriber is installed as a *thread-local* dispatch (via
//!    `set_default`) so that errors before `.setup` (font scan, build-context
//!    macro failures) still produce console output on the main thread. The
//!    returned guard must be held until phase 2 runs.
//!
//! 2. **Phase 2 (in `.setup`, once `app.path().app_log_dir()` is available):**
//!    the *global* default subscriber is installed: a layered setup writing to
//!    BOTH a rolling file appender (daily rotation, max 5 files) and stderr.
//!    The file writer is non-blocking (tracing-appender spawns a dedicated
//!    flusher thread) so logging never stalls the main thread. Once the global
//!    default is set, phase 1's thread-local guard is superseded.
//!
//! `try_init` is used so a second init (or a test harness that already set a
//! global default) is a logged no-op rather than a panic — logging must never
//! affect startup.
//!
//! ## Sanitization (§7.4)
//! Logs must NEVER contain document text, clipboard contents, tokens, or
//! network response bodies. The rule is enforced by convention: every
//! `tracing::` call site uses structured fields carrying paths, ids, counts,
//! and status — never inline `content`/`text`/`body`. The persistence module
//! documents this rule at its top; see `persistence::atomic`.

use std::path::PathBuf;

use tracing_subscriber::{filter::EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// The default log filter (parsed via `EnvFilter`). Overridable via the
/// `RUST_LOG` env var at runtime (the app does not yet expose a UI for this;
/// see §7.4 future work).
pub const DEFAULT_FILTER: &str = "info,typst_studio_lib=debug";

/// Parse the active filter: `RUST_LOG` if set, else [`DEFAULT_FILTER`].
fn active_filter() -> EnvFilter {
    if let Ok(env) = std::env::var("RUST_LOG") {
        if !env.is_empty() {
            return EnvFilter::new(env);
        }
    }
    EnvFilter::new(DEFAULT_FILTER)
}

/// Resolve the diagnostic log directory for this app.
///
/// Mirrors the path `app.path().app_log_dir()` would return, but usable from
/// contexts without an `AppHandle` (e.g. tests). On macOS this is
/// `~/Library/Logs/{bundle-id}`; on Linux `$XDG_STATE_HOME/{bundle-id}/logs`;
/// on Windows `%LOCALAPPDATA%/{bundle-id}\logs`.
pub fn resolve_log_dir() -> std::io::Result<PathBuf> {
    if let Some(dir) = log_dir_via_dirs() {
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }
    // Last-resort fallback (rare).
    let dir = std::env::temp_dir().join("typst-studio").join("logs");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(target_os = "macos")]
fn log_dir_via_dirs() -> Option<PathBuf> {
    // `dirs` is not a direct dependency; reuse the same layout Tauri computes:
    // ~/Library/Logs/<identifier>. Derived from HOME to avoid pulling `dirs`.
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Logs").join("com.typststudio.app"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn log_dir_via_dirs() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(base.join("com.typststudio.app").join("logs"))
}

#[cfg(windows)]
fn log_dir_via_dirs() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("com.typststudio.app").join("logs"))
}

/// Phase 1: install a minimal stderr-only subscriber as a thread-local
/// dispatch so early errors (before `.setup`) are visible. Returns a guard
/// whose drop restores the prior dispatch — keep it alive until phase 2.
pub fn init_early_stderr() -> tracing::subscriber::DefaultGuard {
    let subscriber = fmt::Subscriber::builder()
        .with_writer(std::io::stderr)
        .with_env_filter(active_filter())
        .finish();
    tracing::subscriber::set_default(subscriber)
}

/// Phase 2: install the full layered global subscriber (rolling file + stderr).
/// Safe to call once, inside `.setup`. Uses `try_init` so an already-set global
/// default (e.g. by a test) is a logged no-op rather than a panic.
///
/// Returns the log directory that was opened.
pub fn init_full(log_dir: PathBuf) -> std::result::Result<PathBuf, Vec<String>> {
    std::fs::create_dir_all(&log_dir).map_err(|e| vec![format!("create log dir: {e}")])?;

    // Rolling file appender: daily rotation, keep at most 5 files. `non_blocking`
    // spawns a flusher thread so log writes never block the caller.
    let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("typst-studio")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&log_dir)
        .map_err(|e| vec![format!("build appender: {e}")])?;
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    // The guard must live for the process lifetime. Leaking it is the
    // documented pattern for a process-wide appender (the flusher thread and
    // its join handle are meant to run until exit).
    std::mem::forget(guard);

    let filter = active_filter();
    // Compose into a single global subscriber, then `try_init`. Each layer is
    // boxed (`.boxed()`) and annotated against `tracing_subscriber::Registry`
    // so the `for<S> Layer<S>` blanket impls collapse to a concrete type —
    // without this the compiler spirals into a recursion overflow on macOS
    // (objc2 Retained chains).
    use tracing_subscriber::{Layer, Registry};
    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .boxed();
    let file_layer = fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false) // ANSI codes are noise in a log file
        .boxed();

    Registry::default()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init()
        .map_err(|e| vec![format!("subscriber already initialized: {e}")])?;

    tracing::info!(?log_dir, "diagnostic log initialized");
    Ok(log_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_log_dir_creates_directory() {
        let dir = resolve_log_dir().expect("log dir resolves");
        assert!(dir.exists(), "log dir should exist after resolve: {dir:?}");
    }

    #[test]
    fn default_filter_mentions_crate() {
        // Sanity: the default filter enables debug for this crate so save /
        // startup diagnostics are captured without RUST_LOG.
        assert!(DEFAULT_FILTER.contains("typst_studio_lib"));
    }

    #[test]
    fn active_filter_parses_default() {
        // Without RUST_LOG, the default directive set must parse cleanly.
        std::env::remove_var("RUST_LOG");
        let _ = active_filter();
    }
}
