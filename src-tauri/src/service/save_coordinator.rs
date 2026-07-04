//! `SaveCoordinator` — unified save orchestration with explicit `SaveState`
//! and the §5.2 atomic-save protocol (§5.3).
//!
//! Unifies Save / Save As / Save All / close-save under one coordinator that:
//! - tracks a per-document [`SaveState`] (`Idle` / `Saving` / `Saved` / `Failed`);
//! - runs the §5.2 protocol (prepare → atomic write → mark_saved) in one place,
//!   including the blocking disk write via `spawn_blocking`;
//! - classifies write failures into structured [`IpcError`] codes
//!   (`DiskFull` / `PermissionDenied` / `IoTransient`) and keeps `dirty` TRUE
//!   on failure (§11.2 — dirty only clears after the atomic replace succeeds);
//! - emits `save_state_changed` events on each transition so the frontend can
//!   drive a saving / save-failed status indicator.
//!
//! ## Threading
//!
//! Coordinator methods are `async` and offload the blocking atomic write to
//! `tokio::task::spawn_blocking` (the same runtime Tauri's async commands run
//! on). This encapsulates the §5.2 protocol — including the blocking write —
//! in one place, so the IPC commands stay thin.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter as _};
use tokio::task::spawn_blocking;

use crate::domain::document::DocumentId;
use crate::ipc::error::{ErrorCode, IpcError};
use crate::persistence::atomic::write_bytes;
use crate::service::document_service::DocumentService;

/// Per-document save state machine (§5.3). Emitted on every transition via the
/// `save_state_changed` Tauri event; the frontend mirrors it for the status bar
/// (saving indicator / red save-failed state).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum SaveState {
    /// Not currently saving, last save succeeded (or never attempted).
    Idle,
    /// A save for `revision` is in flight (the write is on a blocking thread).
    Saving {
        #[cfg_attr(feature = "export-types", ts(type = "number"))]
        revision: u64,
    },
    /// The save of `revision` completed — `dirty` is now false.
    Saved {
        #[cfg_attr(feature = "export-types", ts(type = "number"))]
        revision: u64,
    },
    /// The save of `revision` failed with `code` / `message`. `dirty` stays
    /// true; the user may retry / Save As.
    Failed {
        #[cfg_attr(feature = "export-types", ts(type = "number"))]
        revision: u64,
        code: ErrorCode,
        message: String,
    },
}

impl SaveState {
    /// `true` for the [`Saving`](Self::Saving) variant.
    pub fn is_saving(&self) -> bool {
        matches!(self, Self::Saving { .. })
    }
}

/// Default starting state for a freshly-tracked document.
impl Default for SaveState {
    fn default() -> Self {
        Self::Idle
    }
}

/// Per-document result of a [`SaveCoordinator::save_all`] batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct SaveAllResult {
    /// Ids saved successfully in this batch.
    pub saved: Vec<DocumentId>,
    /// Ids that failed or were skipped (because an earlier id failed/cancelled).
    /// Each carries the structured error for the first failure; the rest are
    /// `unreached` (no attempt made).
    pub failed: Vec<SaveAllFailure>,
}

/// One entry in a [`SaveAllResult`]'s `failed` list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct SaveAllFailure {
    pub id: DocumentId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<IpcError>,
}

/// Payload of the `save_state_changed` event: the new save state for `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct SaveStateChangedPayload {
    pub id: DocumentId,
    pub state: SaveState,
}

/// Unified save orchestration (§5.3). Holds an [`Arc<DocumentService>`] for
/// prepare/mark_saved/rebind + the per-doc [`SaveState`] map. Methods are async
/// and run the §5.2 protocol (including the blocking write) end-to-end.
pub struct SaveCoordinator {
    document: Arc<DocumentService>,
    states: RwLock<HashMap<DocumentId, SaveState>>,
    /// Optional Tauri handle for emitting `save_state_changed`. `None` in tests
    /// (or before the app handle exists); transitions still update the in-memory
    /// state map and are queryable via [`save_state`](Self::save_state).
    app: Option<AppHandle>,
}

impl SaveCoordinator {
    /// Construct a coordinator over `document`. `app` emits state-change events;
    /// pass `None` for unit tests.
    pub fn new(document: Arc<DocumentService>, app: Option<AppHandle>) -> Self {
        Self {
            document,
            states: RwLock::new(HashMap::new()),
            app,
        }
    }

    /// The current [`SaveState`] for `id` (defaulting to [`SaveState::Idle`] for
    /// an untracked id). Read by the `save_state` IPC command for the frontend
    /// status display.
    pub fn save_state(&self, id: DocumentId) -> SaveState {
        self.states
            .read()
            .get(&id)
            .cloned()
            .unwrap_or_default()
    }

    /// Save a single document in place (§5.2 / §5.3).
    ///
    /// Protocol:
    /// 1. Read the tab revision (for tagging the [`SaveState`]).
    /// 2. `prepare_save(id)` → `(path, text)`. Maps "untitled / no path" to an
    ///    `InvalidPath` IpcError (the IPC layer's caller — e.g. `saveTab` —
    ///    should fall back to Save As).
    /// 3. Set `SaveState::Saving{revision}`.
    /// 4. `spawn_blocking(write_bytes)` — atomic write (§5.2).
    /// 5. On success: `mark_saved(id)` (clears dirty + recomputes disk_version);
    ///    set `SaveState::Saved{revision}`.
    /// 6. On failure: classify the io error → IpcError code (DiskFull /
    ///    PermissionDenied / IoTransient); **keep dirty TRUE** (§11.2 — dirty
    ///    only clears after the atomic replace succeeds); set
    ///    `SaveState::Failed{revision, code, message}`; return `Err`.
    pub async fn save(&self, id: DocumentId) -> Result<(), IpcError> {
        // 1. Read the revision (best-effort tag — if the tab vanished, surface
        //    NotFound).
        let revision = self
            .document
            .tab_revision(id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("tab {id} not found"), false))?;

        // 2. Prepare (path, text). InvalidInput → InvalidPath.
        let (path, text) = self
            .document
            .prepare_save(id)
            .map_err(|e| IpcError::from(&e))?;
        let path_for_write = path.clone();

        // 3. Saving.
        self.set_state(id, SaveState::Saving { revision });

        // 4. Atomic write on a blocking thread. Don't map_err on the await so we
        // can record the Failed state in the JoinError branch below.
        let write_result: std::result::Result<
            std::result::Result<(), crate::error::AppError>,
            tokio::task::JoinError,
        > = spawn_blocking(move || write_bytes(&path_for_write, text.as_bytes())).await;

        match write_result {
            Ok(Ok(())) => {
                // 5. Success → clear dirty + record disk version, then Saved.
                self.document.mark_saved(id);
                self.set_state(id, SaveState::Saved { revision });
                Ok(())
            }
            Ok(Err(app_err)) => {
                // 6. Failure → classify via the AppError → IpcError mapping,
                // KEEP DIRTY TRUE (mark_saved never ran), Failed state.
                let ipc = IpcError::from(&app_err);
                self.set_state(
                    id,
                    SaveState::Failed {
                        revision,
                        code: ipc.code,
                        message: ipc.message.clone(),
                    },
                );
                Err(ipc)
            }
            Err(join_err) => {
                // spawn_blocking task panicked/join error — transient, dirty stays.
                let message = format!("save join error: {join_err}");
                self.set_state(
                    id,
                    SaveState::Failed {
                        revision,
                        code: ErrorCode::IoTransient,
                        message: message.clone(),
                    },
                );
                Err(IpcError::new(ErrorCode::IoTransient, message, true))
            }
        }
    }

    /// Save As: atomically write `text` to `target`, then — only on write
    /// SUCCESS — rebind the document to the new path (§5.2 / §11.2: path /
    /// registry / resolver / watcher / LSP URI must NOT change before the
    /// replace succeeds). Returns the new canonical path on success.
    ///
    /// The dialog is the IPC layer's job (it needs the AppHandle); this method
    /// takes the already-picked `target` and the buffer `text` so it stays
    /// testable without a dialog.
    pub async fn save_as(
        &self,
        id: DocumentId,
        target: PathBuf,
        text: String,
    ) -> Result<PathBuf, IpcError> {
        let revision = self
            .document
            .tab_revision(id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("tab {id} not found"), false))?;

        self.set_state(id, SaveState::Saving { revision });

        let target_for_write = target.clone();
        // Don't map_err on the await so we can record the Failed state below.
        let write_result: std::result::Result<
            std::result::Result<(), crate::error::AppError>,
            tokio::task::JoinError,
        > = spawn_blocking(move || write_bytes(&target_for_write, text.as_bytes())).await;

        match write_result {
            Ok(Ok(())) => {
                // §5.2: only now (replace succeeded) do we rebind path / registry
                // / resolver / watcher / LSP URI. rebind_path also re-seeds the
                // disk version so the watcher event for our own write is
                // recognized as self-induced.
                self.document
                    .rebind_path(id, target.clone())
                    .map_err(|e| IpcError::from(&e))?;
                self.set_state(id, SaveState::Saved { revision });
                Ok(target)
            }
            Ok(Err(app_err)) => {
                // Write failed → path/registry/etc. UNCHANGED (rebind never ran).
                let ipc = IpcError::from(&app_err);
                self.set_state(
                    id,
                    SaveState::Failed {
                        revision,
                        code: ipc.code,
                        message: ipc.message.clone(),
                    },
                );
                Err(ipc)
            }
            Err(join_err) => {
                let message = format!("save_as join error: {join_err}");
                self.set_state(
                    id,
                    SaveState::Failed {
                        revision,
                        code: ErrorCode::IoTransient,
                        message: message.clone(),
                    },
                );
                Err(IpcError::new(ErrorCode::IoTransient, message, true))
            }
        }
    }

    /// Save each document in `ids` in order (§5.3 Save All).
    ///
    /// On the first FAILURE or CANCEL, **stop**: already-saved docs stay
    /// `Saved`, the failing doc is `Failed`, and the remaining docs are left
    /// untouched (still dirty / `Idle`). Never aborts the whole app on one
    /// failure. Returns the per-doc split.
    pub async fn save_all(&self, ids: Vec<DocumentId>) -> SaveAllResult {
        let mut saved = Vec::new();
        let mut failed: Vec<SaveAllFailure> = Vec::new();
        for id in ids {
            match self.save(id).await {
                Ok(()) => saved.push(id),
                Err(err) => {
                    // First failure: record it with the error, then mark the
                    // rest as unreached (no attempt) and stop.
                    if err.code == ErrorCode::Cancelled {
                        // Cancel stops the batch but is not surfaced as a failure.
                        failed.push(SaveAllFailure { id, error: None });
                    } else {
                        failed.push(SaveAllFailure { id, error: Some(err) });
                    }
                    break;
                }
            }
        }
        SaveAllResult { saved, failed }
    }

    // --- internals ------------------------------------------------------------

    /// Set the state for `id` and emit `save_state_changed` if an `AppHandle`
    /// is wired. Emits are best-effort (no webview → silently dropped).
    fn set_state(&self, id: DocumentId, state: SaveState) {
        self.states.write().insert(id, state.clone());
        if let Some(app) = &self.app {
            let _ = app.emit(
                "save_state_changed",
                SaveStateChangedPayload { id, state },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::compile_service::CompileService;
    use crate::service::editor_service::Emitter;
    use crate::service::tab_store::TabStore;
    use parking_lot::Mutex;

    /// Minimal capturing emitter — only counts compiled events for the wait
    /// helper (we don't assert on save events here).
    struct SpyEmitter {
        compiled_ids: Mutex<Vec<DocumentId>>,
    }
    impl Emitter for SpyEmitter {
        fn emit_compiled(
            &self,
            id: DocumentId,
            _revision: u64,
            _pages: Vec<String>,
            _line_map: Vec<crate::domain::source_map::LineRect>,
            _duration_ms: u64,
        ) {
            self.compiled_ids.lock().push(id);
        }
        fn emit_diagnostics(
            &self,
            _id: DocumentId,
            _revision: u64,
            _d: Vec<crate::domain::diagnostics::Diagnostic>,
        ) {
        }
        fn emit_status(
            &self,
            _id: DocumentId,
            _revision: u64,
            _s: crate::domain::compile_status::CompileStatus,
            _d: Option<u64>,
        ) {
        }
        fn emit_conflict(
            &self,
            _id: DocumentId,
            _revision: u64,
            _c: crate::domain::document::ConflictState,
            _d: Option<String>,
        ) {
        }
    }

    /// Build a wired (DocumentService, CompileService, SaveCoordinator) trio for
    /// tests — no AppHandle, so `set_state` only updates the in-memory map.
    fn make_coordinator() -> (Arc<DocumentService>, SaveCoordinator) {
        let emitter: Arc<dyn Emitter> = Arc::new(SpyEmitter {
            compiled_ids: Mutex::new(Vec::new()),
        });
        let store = TabStore::new(emitter);
        let document = Arc::new(DocumentService::new(store.clone()));
        let compile = Arc::new(CompileService::new(store));
        document.with_compile(compile);
        let coord = SaveCoordinator::new(document.clone(), None);
        (document, coord)
    }

    /// Wait for the initial async compile of `id` to land (so the tab is fully
    /// wired before we save).
    fn wait_compiled(document: &DocumentService, id: DocumentId) {
        // The shared store's compile result is Some once the first compile lands.
        for _ in 0..60 {
            if document.tab_text(id).is_some() {
                // tab exists; compile may still be in flight but save doesn't
                // depend on it. Just give it a beat to settle.
                std::thread::sleep(std::time::Duration::from_millis(15));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    #[tokio::test]
    async fn save_writes_atomically_clears_dirty_and_marks_saved() {
        let dir = std::env::temp_dir().join(format!("ts-svc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "#set page(width: 10cm)\n\nOriginal").unwrap();

        let (document, coord) = make_coordinator();
        let meta = document
            .open_from_content(
                path.clone(),
                "#set page(width: 10cm)\n\nOriginal".into(),
                None,
            )
            .unwrap();
        wait_compiled(&document, meta.id);

        // Edit → dirty.
        document
            .update_text(meta.id, "#set page(width: 10cm)\n\nSaved!".into())
            .unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty);

        // Save via the coordinator.
        coord.save(meta.id).await.expect("save should succeed");

        // dirty cleared, disk has new content, state Saved with the revision.
        assert!(!document.tab_meta(meta.id).unwrap().dirty, "dirty must clear");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("Saved!"));
        let rev = document.tab_revision(meta.id).unwrap();
        match coord.save_state(meta.id) {
            SaveState::Saved { revision } => assert_eq!(revision, rev),
            other => panic!("expected Saved, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §11.2 acceptance: a permission-denied write keeps dirty TRUE and sets
    /// `Failed` with the right code.
    #[cfg(unix)]
    #[tokio::test]
    async fn save_permission_denied_keeps_dirty_true_and_failed_state() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ts-svc-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("readonly.typ");
        std::fs::write(&path, "#set page(width: 10cm)\n\nOriginal").unwrap();

        let (document, coord) = make_coordinator();
        let meta = document
            .open_from_content(
                path.clone(),
                "#set page(width: 10cm)\n\nOriginal".into(),
                None,
            )
            .unwrap();
        wait_compiled(&document, meta.id);
        document
            .update_text(meta.id, "#set page(width: 10cm)\n\nEdited".into())
            .unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty);

        // Make the file read-only (0o444) so the atomic write's temp-create in
        // the same dir still works but the final rename over a read-only file
        // is rejected... actually rename over a read-only target succeeds on
        // Unix if the dir is writable. The reliable permission failure here is
        // to revoke the DIRECTORY's write permission (can't create the temp).
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let err = coord.save(meta.id).await.unwrap_err();
        // Restore so cleanup works.
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));

        // Permission denied (the temp-create in the dir fails).
        assert!(
            err.code == ErrorCode::PermissionDenied || err.code == ErrorCode::IoTransient,
            "expected permission/transient, got {:?}: {}",
            err.code,
            err.message
        );
        assert!(!err.recoverable || err.code == ErrorCode::IoTransient);
        // §11.2: dirty STAYS TRUE.
        assert!(
            document.tab_meta(meta.id).unwrap().dirty,
            "dirty must stay TRUE on save failure (§11.2)"
        );
        // State is Failed with the right code.
        match coord.save_state(meta.id) {
            SaveState::Failed { code, .. } => {
                assert_eq!(code, err.code);
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §11.2: a write failure to an unwritable location keeps dirty TRUE and
    /// leaves the original file untouched.
    #[tokio::test]
    async fn save_failure_to_unwritable_keeps_dirty_and_original_intact() {
        let dir = std::env::temp_dir().join(format!("ts-svc-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // `blocker` is a regular file; treating it as a parent dir fails the
        // atomic write's create_dir_all (NotADirectory) → write fails.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "I am a file").unwrap();
        let bad_target = blocker.join("doc.typ");
        // Open the doc from a good path, then point prepare_save at the bad
        // target by writing through a path the coordinator uses. We exercise
        // save_as here (save in place reads its path from the tab); simulate
        // the failure via save_as to a bad target.
        let good = dir.join("good.typ");
        std::fs::write(&good, "Original").unwrap();

        let (document, coord) = make_coordinator();
        let meta = document
            .open_from_content(good.clone(), "Original".into(), None)
            .unwrap();
        wait_compiled(&document, meta.id);
        document.update_text(meta.id, "Edited".into()).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty);

        let err = coord
            .save_as(meta.id, bad_target.clone(), "Edited".to_string())
            .await
            .unwrap_err();
        assert!(
            err.code == ErrorCode::IoTransient || err.code == ErrorCode::PermissionDenied,
            "got {:?}",
            err.code
        );
        // §11.2: dirty STAYS TRUE; original file untouched.
        assert!(document.tab_meta(meta.id).unwrap().dirty);
        assert_eq!(std::fs::read_to_string(&good).unwrap(), "Original");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.2 / §11.2: a failed Save As leaves path / registry / etc. unchanged
    /// (rebind never ran).
    #[tokio::test]
    async fn save_as_failure_leaves_path_and_registry_unchanged() {
        let dir = std::env::temp_dir().join(format!("ts-svc-sa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.typ");
        std::fs::write(&src, "#set page(width: 10cm)\n\nA").unwrap();
        let src_canon = crate::domain::path::canonicalize_for_identity(&src).unwrap();

        let (document, coord) = make_coordinator();
        let meta = document.open_from_content(src.clone(), "x".into(), None).unwrap();
        wait_compiled(&document, meta.id);
        let id_before = meta.id;
        let path_before = document.tab_meta(meta.id).unwrap().path.clone();

        // Save As to a path inside a file-as-dir blocker → write fails.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "blocker").unwrap();
        let bad_target = blocker.join("b.typ");
        let err = coord
            .save_as(meta.id, bad_target, "new content".to_string())
            .await
            .unwrap_err();
        assert!(err.code != ErrorCode::AlreadyOpen);

        // Path/registry unchanged — rebind_path never ran.
        let after = document.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before);
        assert_eq!(after.path, path_before, "path must be unchanged on save_as failure");
        assert_eq!(
            document.registry().read().find_by_canonical(&src_canon),
            Some(id_before),
            "registry must still point at the original path"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Save As on success rebinds the path.
    #[tokio::test]
    async fn save_as_success_rebinds_path() {
        let dir = std::env::temp_dir().join(format!("ts-svc-saok-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.typ");
        std::fs::write(&src, "#set page(width: 10cm)\n\nA").unwrap();

        let (document, coord) = make_coordinator();
        let meta = document.open_from_content(src.clone(), "x".into(), None).unwrap();
        wait_compiled(&document, meta.id);
        let id_before = meta.id;

        let dst = dir.join("b.typ");
        let returned = coord
            .save_as(meta.id, dst.clone(), "#set page(width: 10cm)\n\nB".to_string())
            .await
            .expect("save_as should succeed");
        assert_eq!(returned, dst);

        let dst_canon = crate::domain::path::canonicalize_for_identity(&dst).unwrap();
        let after = document.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "id preserved");
        assert_eq!(after.path.as_deref(), Some(dst_canon.as_path()));
        assert!(!after.dirty, "save_as clears dirty");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "#set page(width: 10cm)\n\nB");
        match coord.save_state(meta.id) {
            SaveState::Saved { .. } => {}
            other => panic!("expected Saved, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.3 Save All: stops on the first failure; prior docs Saved, the rest
    /// untouched.
    #[tokio::test]
    async fn save_all_stops_on_first_failure() {
        let dir = std::env::temp_dir().join(format!("ts-svc-all-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let (document, coord) = make_coordinator();
        // doc_a: saveable file.
        let a = dir.join("a.typ");
        std::fs::write(&a, "#set page(width: 10cm)\n\nA").unwrap();
        let meta_a = document.open_from_content(a.clone(), "#set page(width: 10cm)\n\nA".into(), None).unwrap();
        wait_compiled(&document, meta_a.id);
        document.update_text(meta_a.id, "#set page(width: 10cm)\n\nA-edited".into()).unwrap();
        assert!(document.tab_meta(meta_a.id).unwrap().dirty);

        // doc_b: an untitled tab — save fails (no path).
        let meta_b = document.new_tab(None);
        wait_compiled(&document, meta_b.id);
        document.update_text(meta_b.id, "untitled edits".into()).unwrap();
        assert!(document.tab_meta(meta_b.id).unwrap().dirty);

        // doc_c: another saveable file — should NOT be reached (b fails first).
        let c = dir.join("c.typ");
        std::fs::write(&c, "#set page(width: 10cm)\n\nC").unwrap();
        let meta_c = document.open_from_content(c.clone(), "#set page(width: 10cm)\n\nC".into(), None).unwrap();
        wait_compiled(&document, meta_c.id);
        document.update_text(meta_c.id, "#set page(width: 10cm)\n\nC-edited".into()).unwrap();

        let result = coord.save_all(vec![meta_a.id, meta_b.id, meta_c.id]).await;
        // a saved, b failed, c unreached (not in either list — stop on first fail).
        assert_eq!(result.saved, vec![meta_a.id], "doc_a should be saved");
        assert!(!document.tab_meta(meta_a.id).unwrap().dirty, "doc_a clean");
        assert_eq!(result.failed.len(), 1, "exactly one failure recorded");
        assert_eq!(result.failed[0].id, meta_b.id);
        // The failing doc (b) stays dirty.
        assert!(document.tab_meta(meta_b.id).unwrap().dirty, "doc_b stays dirty");
        // c was never attempted → still dirty, state Idle.
        assert!(document.tab_meta(meta_c.id).unwrap().dirty, "doc_c untouched");
        assert!(matches!(coord.save_state(meta_c.id), SaveState::Idle));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// save_state defaults to Idle for an untracked id.
    #[tokio::test]
    async fn save_state_defaults_to_idle() {
        let (_document, coord) = make_coordinator();
        let unknown = DocumentId::new();
        assert!(matches!(coord.save_state(unknown), SaveState::Idle));
    }

    /// save on an unknown id surfaces NotFound.
    #[tokio::test]
    async fn save_unknown_id_returns_not_found() {
        let (_document, coord) = make_coordinator();
        let err = coord.save(DocumentId::new()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        SaveState::export(&cfg).unwrap();
        SaveAllResult::export(&cfg).unwrap();
        SaveAllFailure::export(&cfg).unwrap();
        SaveStateChangedPayload::export(&cfg).unwrap();
    }
}
