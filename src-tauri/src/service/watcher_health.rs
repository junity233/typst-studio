//! `WatcherHealth` — polling fallback for filesystem-watch degradation (§6.3
//! "定期轻量校验打开文件的 DiskVersion 作为降级补偿").
//!
//! The native watcher (`notify`) is reliable on most platforms, but FSEvents
//! (macOS) and inotify (Linux) have known edge cases where a watch silently
//! stops delivering events (renames, mount boundaries, fd-pressure drops). When
//! that happens the editor would never learn about an external edit until the
//! user's next manual reload. This module is the safety net: a periodic
//! background poll that re-reads each open document's [`DiskVersion`] and
//! routes a divergence through the SAME `handle_external_change` path the
//! watcher uses.
//!
//! ## Why a poll loop (and not just "fix the watcher")?
//!
//! `notify`'s edge cases are platform-level and not something the app can
//! eliminate. A cheap periodic re-check (a `stat` + cheap hash per open doc,
//! every [`POLL_INTERVAL`]) is the standard fallback editors use (VS Code,
//! Sublime, etc. all layer a poll over their native watchers). It is active
//! ONLY when there are open docs, so an idle editor pays nothing.
//!
//! ## Overlap with the watcher (idempotency)
//!
//! The poll may fire for a change the watcher ALSO fires. That's safe:
//! `handle_external_change` is idempotent via [`DiskVersion`] equality — a
//! second invocation for the same on-disk version compares equal and is a
//! no-op. So a double-fire costs one redundant `stat`-and-compare, never a
//! duplicate reload/conflict. This is documented in `handle_version_change`
//! (the "content identical AND inode identical → no-op" arm).
//!
//! ## Health indicator
//!
//! The service also tracks whether the workspace watcher FAILED to start
//! (set by `WorkspaceService::open` on a watcher-creation error). The frontend
//! surfaces a "external detection unavailable" warning while it's set; a
//! successful re-open (which restarts the watcher) clears it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::domain::document::DocumentOrigin;
use crate::service::tab_store::{handle_external_change_locked, Tabs};

use super::tab_store::TabStore;

/// How often the polling fallback re-checks open docs' disk versions (§6.3).
/// 10s is a balance: fast enough to catch a silent-watcher miss within a few
/// seconds of the user looking, slow enough that the per-doc `stat` cost
/// (microseconds each) is negligible even with many tabs.
pub const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// `WatcherHealth` owns the polling-fallback background thread and the
/// watcher-failed flag (§6.3).
///
/// Constructed once at app startup and held by the app state. The poll thread
/// captures clones of the shared `Arc`s from [`TabStore`] (the same discipline
/// the loose-file watcher uses — never a service `Arc`, to avoid cycles). It
/// exits cleanly when [`WatcherHealth::shutdown`] sets the stop flag.
pub struct WatcherHealth {
    /// Set by `WorkspaceService::open` when the workspace watcher failed to
    /// start. Surfaced to the frontend so it can warn "external detection
    /// unavailable". Cleared on a successful re-open.
    watcher_failed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    _thread: Option<JoinHandle<()>>,
}

impl WatcherHealth {
    /// Start the polling-fallback thread over the given store. The thread runs
    /// until [`shutdown`](Self::shutdown) (or drop). It only does work when
    /// there are open docs (it re-checks the registry each tick).
    pub fn start(store: TabStore) -> Self {
        let watcher_failed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));

        let watcher_failed_clone = Arc::clone(&watcher_failed);
        let stop_clone = Arc::clone(&stop);
        let registry = store.registry.clone();
        let tabs = store.tabs.clone();
        let emitter = store.emitter.clone();

        let thread = std::thread::Builder::new()
            .name("typst-watcher-health".into())
            .spawn(move || {
                Self::poll_loop(
                    watcher_failed_clone,
                    stop_clone,
                    registry,
                    tabs,
                    emitter,
                );
            })
            .expect("failed to spawn watcher-health thread");

        Self {
            watcher_failed,
            stop,
            _thread: Some(thread),
        }
    }

    /// The background poll loop. Each tick:
    /// 1. Sleep [`POLL_INTERVAL`] (or exit if stopped).
    /// 2. Enumerate open docs via the registry.
    /// 3. For each doc with a disk path, call `handle_external_change_locked` —
    ///    which re-reads the DiskVersion and routes a divergence through the
    ///    normal external-change path (content-differs → Modified conflict,
    ///    surfaced to the user to resolve).
    fn poll_loop(
        _watcher_failed: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
        registry: crate::domain::registry::SharedRegistry,
        tabs: Tabs,
        emitter: Arc<dyn super::editor_service::Emitter>,
    ) {
        while !stop.load(Ordering::SeqCst) {
            // Sleep first so an immediate shutdown doesn't do a pointless poll,
            // and so the loop's first check happens after one interval (not at
            // startup, when nothing has changed yet).
            std::thread::sleep(POLL_INTERVAL);
            if stop.load(Ordering::SeqCst) {
                return;
            }

            // Collect the canonical paths of every open doc that has one. We
            // snapshot under a brief read lock, then run the (lock-free) disk
            // checks outside the lock. A doc closed between the snapshot and
            // the check is harmless: handle_external_change re-resolves the id
            // from the registry and no-ops if it's gone.
            let paths: Vec<PathBuf> = {
                let reg = registry.read();
                reg.list()
                    .into_iter()
                    .filter_map(|meta| match &meta.origin {
                        DocumentOrigin::WorkspaceFile { path, .. }
                        | DocumentOrigin::LooseFile { path, .. } => Some(path.clone()),
                        DocumentOrigin::Untitled => None,
                    })
                    .collect()
            };

            for path in paths {
                // Re-route through the shared external-change handler. It's
                // idempotent (DiskVersion equality), so a watcher event that
                // already fired for this change is a no-op here.
                handle_external_change_locked(&path, &tabs, &registry, &emitter);
            }
        }
    }

    /// Mark the workspace watcher as failed to start (§6.3 "状态栏明确提示
    /// 外部修改检测不可用"). Called by `WorkspaceService::open` on a watcher
    /// error. The polling fallback still runs regardless — it's the
    /// compensation for the failed watcher.
    pub fn mark_watcher_failed(&self) {
        self.watcher_failed.store(true, Ordering::SeqCst);
    }

    /// Clear the watcher-failed flag (§6.3 "watcher 恢复后清除警告"). Called by
    /// `WorkspaceService::open` on a successful watcher start.
    pub fn clear_watcher_failed(&self) {
        self.watcher_failed.store(false, Ordering::SeqCst);
    }

    /// Whether the workspace watcher failed to start (frontend surfaces a
    /// warning when true). The polling fallback is independent of this flag —
    /// it always runs while there are open docs.
    pub fn watcher_failed(&self) -> bool {
        self.watcher_failed.load(Ordering::SeqCst)
    }

    /// Stop the polling thread. The thread notices within one [`POLL_INTERVAL`]
    /// and exits. Not joined in Drop (blocking in Drop is bad practice); the
    /// thread is a daemon that exits on its own via the stop flag.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for WatcherHealth {
    fn drop(&mut self) {
        // Signal the thread to stop so it doesn't outlive the health service
        // by more than one POLL_INTERVAL. Don't join (the thread may be mid-
        // sleep; blocking in Drop is bad practice).
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::document::{ConflictState, DocumentId};
    use crate::domain::diagnostics::Diagnostic;
    use crate::domain::source_map::LineRect;
    use crate::service::editor_service::Emitter;
    use crate::service::tab_state::TabState;
    use parking_lot::Mutex as PlMutex;
    use std::fs;
    use std::path::PathBuf;

    /// A recording emitter that captures conflict emits (the observable
    /// side-effect of handle_external_change finding a divergence).
    #[derive(Default)]
    struct ConflictsEmitter {
        conflicts: PlMutex<Vec<(DocumentId, ConflictState)>>,
    }

    impl Emitter for ConflictsEmitter {
        fn emit_compiled(
            &self,
            _id: DocumentId,
            _revision: u64,
            _page_count: usize,
            _full: bool,
            _changed_pages: Vec<crate::ipc::events::ChangedPage>,
            _line_map: Vec<LineRect>,
            _outline: Vec<crate::domain::outline::OutlineNode>,
            _duration_ms: u64,
        ) {
        }
        fn emit_diagnostics(
            &self,
            _id: DocumentId,
            _revision: u64,
            _diagnostics: Vec<Diagnostic>,
        ) {
        }
        fn emit_status(
            &self,
            _id: DocumentId,
            _revision: u64,
            _status: crate::domain::compile_status::CompileStatus,
            _duration_ms: Option<u64>,
        ) {
        }
        fn emit_conflict(
            &self,
            id: DocumentId,
            _revision: u64,
            conflict: ConflictState,
            _disk_content: Option<String>,
        ) {
            self.conflicts.lock().push((id, conflict));
        }
    }

    /// Open a clean doc backed by a real temp file, with the registry + tabs
    /// wired exactly as the editor does. Returns the store + id + file path.
    fn open_doc(text: &str) -> (TabStore, DocumentId, PathBuf) {
        let emitter: Arc<dyn Emitter> = Arc::new(ConflictsEmitter::default());
        let store = TabStore::new(emitter);
        let id = DocumentId::new();
        let dir = std::env::temp_dir().join(format!("typst-wh-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        fs::write(&path, text).unwrap();
        let canon = path.canonicalize().unwrap();

        // Build the tab with a LooseFile origin matching the canonical path,
        // and seed the disk_version the way DocumentService::open does.
        let meta = crate::domain::document::DocumentMeta::with_loose_path(
            id,
            canon.clone(),
            canon.parent().unwrap().to_path_buf(),
        );
        let tab = Arc::new(TabState::with_meta(meta.clone(), text.to_string()));
        // Seed disk_version so the poll can detect a change.
        {
            let mut rt = tab.state.lock();
            rt.disk_version =
                Some(crate::domain::disk_version::DiskVersion::from_path(&canon).unwrap());
            rt.file_identity = crate::domain::disk_version::FileIdentity::from_path(&canon);
        }
        store.tabs.write().insert(id, tab);
        store.registry.write().register(meta).unwrap();
        (store, id, canon)
    }

    #[test]
    fn poll_detects_external_change_with_no_watcher() {
        // Simulate a silent watcher: we never start one. The poll loop should
        // still detect an external disk change by re-checking DiskVersion.
        let (store, id, canon) = open_doc("original");
        let health = WatcherHealth::start(store.clone());

        // Mutate the file on disk AFTER the open (which seeded the version).
        // A short sleep lets at least one POLL_INTERVAL... but the default
        // interval is 10s, too slow for a unit test. Instead, drive the check
        // directly via handle_external_change_locked (the same fn the loop
        // calls) to assert the detection path works. The loop's role is just
        // to call this periodically; the detection logic is what we test here.
        fs::write(&canon, "externally changed").unwrap();
        // Directly invoke the poll's per-doc call (the loop would do this).
        crate::service::tab_store::handle_external_change_locked(
            &canon,
            &store.tabs,
            &store.registry,
            &store.emitter,
        );

        health.shutdown();
        // The doc was clean (not dirty), but external changes now surface as a
        // Modified conflict for the user to resolve explicitly (rather than a
        // silent auto-reload). Assert the buffer is UNCHANGED and the tab is
        // flagged Modified — the disk content is applied only when the user
        // confirms via resolve_conflict_use_disk.
        let tab = store.tabs.read().get(&id).cloned().expect("tab still open");
        assert_eq!(
            tab.world.text(),
            "original",
            "buffer must not be silently reloaded; the user must confirm the external change"
        );
        {
            let rt = tab.state.lock();
            assert!(
                matches!(rt.meta.conflict, ConflictState::Modified { .. }),
                "external change on a clean doc should surface as Modified conflict, got {:?}",
                rt.meta.conflict
            );
        }
        let _ = fs::remove_dir_all(canon.parent().unwrap());
    }

    #[test]
    fn watcher_failed_flag_toggles() {
        let emitter: Arc<dyn Emitter> = Arc::new(ConflictsEmitter::default());
        let store = TabStore::new(emitter);
        let health = WatcherHealth::start(store);
        assert!(!health.watcher_failed(), "starts healthy");
        health.mark_watcher_failed();
        assert!(health.watcher_failed(), "flag set after failure");
        health.clear_watcher_failed();
        assert!(!health.watcher_failed(), "flag cleared on recovery");
        health.shutdown();
    }

    #[test]
    fn poll_is_idempotent_with_repeated_checks() {
        // Two consecutive checks for the SAME on-disk version must not double-
        // fire (DiskVersion equality short-circuits to a no-op). We verify the
        // poll's per-doc call is safe to repeat; the deeper idempotency
        // (content-equal → no-op) is covered by handle_version_change's
        // own tests.
        let (store, _id, canon) = open_doc("stable");
        // No mutation → both checks are no-ops (no panic, clean exit).
        for _ in 0..3 {
            crate::service::tab_store::handle_external_change_locked(
                &canon,
                &store.tabs,
                &store.registry,
                &store.emitter,
            );
        }
        let _ = fs::remove_dir_all(canon.parent().unwrap());
    }
}
