//! Workspace filesystem watcher.
//!
//! Watches the workspace root (recursively) for changes and delivers debounced
//! batches of affected paths to a callback. The callback is where the
//! [`crate::service::WorkspaceService`] turns disk events into a `fs_changed`
//! Tauri event for the frontend to refresh its file tree.
//!
//! Uses `notify` directly (rather than `notify-debouncer-mini`, whose version
//! matrix against `notify` is fragile). Debouncing is a small coalescing loop:
//! the watcher pushes paths into a buffer; a timer thread flushes it every
//! `debounce` window and invokes `on_change` with the deduplicated batch. A
//! burst of edits (e.g. a build writing many files) thus collapses into one
//! notification.
//!
//! The watcher runs until the returned [`WatcherGuard`] is dropped.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::error::{AppError, Result};

// `.watch()` is a trait method on `notify::Watcher`; bring the trait into scope.
use notify::Watcher as _;

/// A reasonable debounce window for INTERNAL watchers that are not surfaced as
/// a user setting (e.g. the themes-dir hot-reload watcher, the loose-file
/// watcher). The user-tunable workspace watcher reads `compiler.debounceMs`
/// from settings instead. Kept here so internal call sites share one value.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(300);

/// Callback invoked (on the flush thread) with the deduplicated paths that
/// changed. Wrapped in `Arc` so it can be shared into the watcher thread.
pub type OnChange = Arc<dyn Fn(&[PathBuf]) + Send + Sync>;

/// A handle that keeps the watcher alive. Dropping it stops the watcher and
/// signals the flush thread to exit; the thread is not joined (it is a
/// short-lived daemon that notices the stop flag within one debounce window).
pub struct WatcherGuard {
    stop: Arc<AtomicBool>,
    // Held (never read after construction) so the watcher stays alive for the
    // guard's lifetime. Drop drops it, which stops the platform watch.
    _watcher: notify::RecommendedWatcher,
    // Held (not joined) so the thread isn't reaped while the guard lives. Drop
    // detaches it; it exits on its own via the `stop` flag.
    _flush_thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unwatch isn't necessary; dropping the watcher stops it. The flush
        // thread notices `stop` within one debounce window and exits.
    }
}

/// Start watching `root` recursively. `on_change` is called on the flush thread
/// with the changed paths whenever a debounced batch arrives. `debounce` is the
/// quiet-period window the flush thread waits before delivering a batch; a
/// smaller value yields fresher notifications (at the cost of more batches under
/// a burst), a larger value coalesces more aggressively.
///
/// Errors if the platform watcher could not be initialized or `root` could not
/// be watched.
pub fn watch(root: &Path, debounce: Duration, on_change: OnChange) -> Result<WatcherGuard> {
    // Shared, deduplicated buffer of paths changed since the last flush.
    let pending: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    let pending_for_cb = Arc::clone(&pending);

    let watcher = notify::recommended_watcher(move |res: std::result::Result<
        notify::Event,
        notify::Error,
    >| {
        match res {
            Ok(event) => {
                if event.paths.is_empty() {
                    return;
                }
                let mut buf = pending_for_cb.lock();
                for p in event.paths {
                    if !buf.contains(&p) {
                        buf.push(p);
                    }
                }
            }
            // notify errors are non-fatal (e.g. a watched dir was deleted);
            // log and continue rather than killing the watcher.
            Err(e) => tracing::warn!("filesystem watcher error: {e}"),
        }
    })
    .map_err(|e| AppError::Other(format!("failed to start fs watcher: {e}")))?;

    let mut watcher = watcher;
    watcher
        .watch(root, notify::RecursiveMode::Recursive)
        .map_err(|e| AppError::Other(format!("failed to watch {root:?}: {e}")))?;

    // Flush thread: every `debounce`, if there are pending paths, drain and
    // deliver them. Exits when `stop` is set (checked once per window).
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);
    let pending_for_flush = Arc::clone(&pending);
    let on_change_flush = Arc::clone(&on_change);
    let flush_thread = std::thread::Builder::new()
        .name("typst-fs-watcher".into())
        .spawn(move || {
            let mut next_flush = Instant::now() + debounce;
            loop {
                let now = Instant::now();
                if now < next_flush {
                    std::thread::sleep(next_flush - now);
                }
                if stop_clone.load(Ordering::SeqCst) {
                    return;
                }
                let batch: Vec<PathBuf> = {
                    let mut buf = pending_for_flush.lock();
                    if buf.is_empty() {
                        next_flush = Instant::now() + debounce;
                        continue;
                    }
                    std::mem::take(&mut *buf)
                };
                if !batch.is_empty() {
                    on_change_flush(&batch);
                }
                next_flush = Instant::now() + debounce;
            }
        })
        .map_err(|e| AppError::Other(format!("failed to spawn fs watcher thread: {e}")))?;

    Ok(WatcherGuard {
        stop,
        _watcher: watcher,
        _flush_thread: Some(flush_thread),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[test]
    fn watch_delivers_changes_for_a_written_file() {
        let root =
            std::env::temp_dir().join(format!("typst-watcher-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("seed.typ"), "x").unwrap();

        let received: Arc<StdMutex<Vec<PathBuf>>> = Arc::new(StdMutex::new(Vec::new()));
        let received_cb = Arc::clone(&received);
        let on_change: OnChange = Arc::new(move |paths: &[PathBuf]| {
            received_cb.lock().unwrap().extend_from_slice(paths);
        });

        let guard = watch(&root, Duration::from_millis(300), on_change).expect("watcher should start");
        // Mutate a file; the watcher should surface it within a few debounce windows.
        std::fs::write(root.join("changed.typ"), "y").unwrap();
        for _ in 0..30 {
            std::thread::sleep(Duration::from_millis(150));
            let got = received.lock().unwrap().clone();
            if got.iter().any(|p| p.ends_with("changed.typ")) {
                drop(guard);
                let _ = std::fs::remove_dir_all(&root);
                return;
            }
        }
        drop(guard);
        let _ = std::fs::remove_dir_all(&root);
        panic!("watcher never reported the changed file");
    }
}
