//! `EditorService` — the IPC-facing facade over [`DocumentService`] +
//! [`CompileService`] (Phase 4, §6.1 / §6.3 / §14).
//!
//! ## Why a facade?
//!
//! Phase 4 splits the old monolithic editor along two seams:
//! - [`DocumentService`](super::document_service::DocumentService) — document
//!   identity, buffers, registry, origin transitions, conflict state (§6.1).
//! - [`CompileService`](super::compile_service::CompileService) — per-document
//!   compile workers, scheduling, revision-tagged results, rendering (§6.3).
//!
//! Per the spec's "保持 IPC facade，在内部迁移调用方" / "渐进拆分" guidance,
//! the IPC command layer keeps calling `state.editor.<method>()` unchanged
//! (no signature churn across ~15 command files). [`EditorService`] is now a
//! thin holder of the two services that delegates every method one-to-one. The
//! real logic lives in the service that owns it; this struct exists to preserve
//! the facade contract and to wire the two siblings together at construction.
//!
//! ## What stays here
//!
//! Two cross-cutting types that both services (and the IPC/event layer) depend
//! on remain defined in this module for source compatibility:
//! - the [`Emitter`] trait (the event-delivery abstraction), and
//! - [`CompileState`] (the revision-pinned snapshot used by export).
//!
//! The shared backing state lives in
//! [`TabStore`](super::tab_store::TabStore); the per-tab world + runtime in
//! [`TabState`](super::tab_state::TabState).

use std::sync::Arc;

use typst_layout::PagedDocument;

use crate::domain::compile_status::CompileStatus;
use crate::domain::diagnostics::Diagnostic;
use crate::domain::document::{ConflictState, DocumentId, DocumentMeta};
use crate::domain::registry::SharedRegistry;
use crate::domain::source_map::LineRect;
use crate::error::Result;

use super::compile_service::CompileService;
use super::document_service::DocumentService;
use super::tab_store::TabStore;
use super::workspace_service::WorkspaceService;

use std::path::{Path, PathBuf};

/// Decouples the service layer from the concrete event-delivery mechanism.
///
/// In production this is backed by a Tauri `AppHandle`
/// ([`crate::ipc::state::TauriEmitter`]); in tests by a `CapturingEmitter` that
/// records emits for assertion.
///
/// Every emit carries a `revision` (§7): the document revision the result
/// corresponds to. Stale-revision results are discarded by the frontend.
pub trait Emitter: Send + Sync {
    /// Notify the frontend of a successful compile with rendered SVG pages and
    /// the source map (source line → preview-page bbox).
    fn emit_compiled(
        &self,
        id: DocumentId,
        revision: u64,
        pages: Vec<String>,
        line_map: Vec<LineRect>,
        outline: Vec<crate::domain::outline::OutlineNode>,
        duration_ms: u64,
    );
    /// Notify the frontend of compile errors.
    fn emit_diagnostics(&self, id: DocumentId, revision: u64, diagnostics: Vec<Diagnostic>);
    /// Notify the frontend of a compile status transition.
    fn emit_status(
        &self,
        id: DocumentId,
        revision: u64,
        status: CompileStatus,
        duration_ms: Option<u64>,
    );
    /// Notify the frontend of an external-modification conflict (§8.4). Emits
    /// the disk content (for `Modified`, so the UI can show a diff) and the
    /// new conflict state. `revision` tags the buffer revision.
    fn emit_conflict(
        &self,
        id: DocumentId,
        revision: u64,
        conflict: ConflictState,
        disk_content: Option<String>,
    );
}

/// Point-in-time snapshot of a tab's last compile result, for export (§9).
/// See [`EditorService::last_compile_state`]. Export pins results to a revision
/// via this triple: a doc is only rendered when the requested revision is the
/// one that actually compiled successfully; a failed revision surfaces its
/// diagnostics instead of an older doc.
pub struct CompileState {
    /// The revision this compile corresponds to, or `None` before the first
    /// compile completes.
    pub last_compiled_revision: Option<u64>,
    /// Whether that compile succeeded.
    pub success: bool,
    /// The rendered document on success (`None` on failure or before first
    /// compile).
    pub doc: Option<PagedDocument>,
    /// Error diagnostics from that compile (empty on success).
    pub errors: Vec<Diagnostic>,
}

/// The IPC-facing facade over the document + compile services (Phase 4).
///
/// Holds the two sibling services and delegates every method one-to-one. IPC
/// commands keep calling `state.editor.<method>()` — no signature changes. The
/// actual logic lives in [`DocumentService`] and [`CompileService`]; this struct
/// exists to preserve the facade contract and to wire the siblings' back
/// references at construction time.
pub struct EditorService {
    document: Arc<DocumentService>,
    compile: Arc<CompileService>,
}

impl EditorService {
    /// Construct the facade, building the two sibling services over one shared
    /// [`TabStore`] and wiring the document service's compile back-reference.
    pub fn new(emitter: Arc<dyn Emitter>) -> Self {
        let store = TabStore::new(emitter);
        let document = Arc::new(DocumentService::new(store.clone()));
        let compile = Arc::new(CompileService::new(store));
        // Wire the document → compile back-reference used for worker rotation
        // on origin changes (Save As, reclassify).
        document.with_compile(compile.clone());
        Self { document, compile }
    }

    /// The document-identity service (§6.1). Exposed so new IPC callers (and
    /// tests) can address it directly; existing callers keep using the
    /// delegated methods below.
    pub fn document(&self) -> &Arc<DocumentService> {
        &self.document
    }

    /// The compile service (§6.3).
    pub fn compile(&self) -> &Arc<CompileService> {
        &self.compile
    }

    // --- delegation: document identity / buffers -----------------------------

    /// Read-only access to the document registry. Delegates to
    /// [`DocumentService::registry`].
    pub fn registry(&self) -> &SharedRegistry {
        self.document.registry()
    }

    /// Delegates to [`DocumentService::new_tab`].
    pub fn new_tab(&self, content: Option<String>) -> DocumentMeta {
        self.document.new_tab(content)
    }

    /// Delegates to [`DocumentService::open_from_content`].
    pub fn open_from_content(
        &self,
        path: PathBuf,
        content: String,
        workspace: Option<&WorkspaceService>,
    ) -> Result<DocumentMeta> {
        self.document.open_from_content(path, content, workspace)
    }

    /// Delegates to [`DocumentService::open_from_disk`].
    pub fn open_from_disk(
        &self,
        path: PathBuf,
        content: String,
        workspace: Option<&WorkspaceService>,
    ) -> Result<DocumentMeta> {
        self.document.open_from_disk(path, content, workspace)
    }

    /// Delegates to [`DocumentService::mark_saved`].
    pub fn mark_saved(&self, id: DocumentId, saved_revision: u64) {
        self.document.mark_saved(id, saved_revision);
    }

    /// Delegates to [`DocumentService::handle_external_change`].
    pub fn handle_external_change(&self, path: &Path) {
        self.document.handle_external_change(path);
    }

    /// Delegates to [`DocumentService::rebind_path`].
    pub fn rebind_path(&self, id: DocumentId, target_path: PathBuf) -> Result<()> {
        self.document.rebind_path(id, target_path)
    }

    /// Deprecated alias — delegates to [`DocumentService::assign_path`].
    #[deprecated(note = "use rebind_path — it rebuilds the world and recompiles")]
    pub fn assign_path(&self, id: DocumentId, path: PathBuf) -> Result<()> {
        #[allow(deprecated)]
        self.document.assign_path(id, path)
    }

    /// Delegates to [`DocumentService::reclassify_documents`].
    pub fn reclassify_documents(&self, ws: &WorkspaceService) {
        self.document.reclassify_documents(ws);
    }

    /// Delegates to [`DocumentService::close_tab`].
    pub fn close_tab(&self, id: DocumentId) -> Result<()> {
        self.document.close_tab(id)
    }

    /// Delegates to [`DocumentService::update_text`].
    pub fn update_text(&self, id: DocumentId, content: String) -> Result<()> {
        self.document.update_text(id, content)
    }

    /// Delegates to [`DocumentService::prepare_save`].
    pub fn prepare_save(&self, id: DocumentId) -> Result<(PathBuf, String)> {
        self.document.prepare_save(id)
    }

    /// Delegates to [`DocumentService::resolve_conflict_use_disk`] (§5.4).
    pub fn resolve_conflict_use_disk(&self, id: DocumentId) -> Result<String> {
        self.document.resolve_conflict_use_disk(id)
    }

    /// Delegates to [`DocumentService::clear_conflict`] (§5.4).
    pub fn clear_conflict(&self, id: DocumentId) -> Result<()> {
        self.document.clear_conflict(id)
    }

    /// Delegates to [`DocumentService::clear_dirty`].
    pub fn clear_dirty(&self, id: DocumentId) {
        self.document.clear_dirty(id);
    }

    /// Delegates to [`DocumentService::set_dirty`].
    pub fn set_dirty(&self, id: DocumentId, dirty: bool) {
        self.document.set_dirty(id, dirty);
    }

    /// Delegates to [`DocumentService::flush_recovery`].
    pub fn flush_recovery(&self) {
        self.document.flush_recovery();
    }

    /// Snapshot the recovery service handle, if wired (§5.1). Exposed so the
    /// IPC + setup layers can reach the recovery API (discard, list, clean
    /// marker) without a separate state field.
    pub fn recovery(&self) -> Option<Arc<crate::persistence::recovery::RecoveryService>> {
        self.document.recovery()
    }

    // --- delegation: compile --------------------------------------------------

    /// Delegates to [`CompileService::compile_now`].
    pub fn compile_now(&self, id: DocumentId) {
        self.compile.compile_now(id);
    }

    /// Delegates to [`CompileService::get_diagnostics`].
    pub fn get_diagnostics(&self, id: DocumentId) -> Vec<Diagnostic> {
        self.compile.get_diagnostics(id)
    }

    /// Delegates to [`CompileService::last_doc`] via
    /// Delegates to [`CompileService::last_doc`].
    pub fn last_doc(&self, id: DocumentId) -> Option<PagedDocument> {
        self.compile.last_doc(id)
    }

    /// Delegates to [`CompileService::last_compile_state`].
    pub fn last_compile_state(&self, id: DocumentId) -> Option<CompileState> {
        self.compile.last_compile_state(id)
    }

    // --- delegation: accessors ------------------------------------------------

    /// Delegates to [`DocumentService::tab_meta`].
    pub fn tab_meta(&self, id: DocumentId) -> Option<DocumentMeta> {
        self.document.tab_meta(id)
    }

    /// Delegates to [`DocumentService::tab_revision`].
    pub fn tab_revision(&self, id: DocumentId) -> Option<u64> {
        self.document.tab_revision(id)
    }

    /// Delegates to [`DocumentService::list_tabs`].
    pub fn list_tabs(&self) -> Vec<DocumentMeta> {
        self.document.list_tabs()
    }

    /// Delegates to [`DocumentService::tab_text`].
    pub fn tab_text(&self, id: DocumentId) -> Option<String> {
        self.document.tab_text(id)
    }

    /// Number of parent directories currently cached in the loose-resolver map.
    /// Test-only accessor for asserting cache sharing (§4.2).
    #[cfg(test)]
    pub fn loose_resolver_cache_len(&self) -> usize {
        self.document.loose_resolver_cache_len()
    }

    /// Number of out-of-workspace parent dirs currently watched by loose-file
    /// watchers. Test-only accessor for asserting watcher installation (§4.2).
    #[cfg(test)]
    pub fn loose_watcher_count(&self) -> usize {
        self.document.loose_watcher_count()
    }

    /// Test-only: whether the on-disk version has been seeded for `id` (used by
    /// the external-change tests to await open completion). Routes through the
    /// shared store rather than exposing the tab map.
    #[cfg(test)]
    pub(crate) fn disk_version_seeded(&self, id: DocumentId) -> bool {
        self.document
            .store()
            .tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().disk_version.is_some())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::pipeline::RenderPipeline;
    use parking_lot::Mutex;

    // --- test doubles --------------------------------------------------------

    /// An event captured by `CapturingEmitter`, for assertion in tests.
    ///
    /// The payload fields mirror the real wire format so a test asserting on
    /// specifics (pages, diagnostics, status) has the data available, even
    /// though current assertions only check event presence + id. The `revision`
    /// field is the document revision the result corresponds to (§7).
    #[allow(dead_code)]
    #[derive(Clone, Debug)]
    enum CapturedEvent {
        Compiled {
            id: DocumentId,
            revision: u64,
            pages: Vec<String>,
            line_map: Vec<LineRect>,
            outline: Vec<crate::domain::outline::OutlineNode>,
            duration_ms: u64,
        },
        Diagnostics {
            id: DocumentId,
            revision: u64,
            diagnostics: Vec<Diagnostic>,
        },
        Status {
            id: DocumentId,
            revision: u64,
            status: CompileStatus,
            duration_ms: Option<u64>,
        },
        Conflict {
            id: DocumentId,
            revision: u64,
            conflict: ConflictState,
            disk_content: Option<String>,
        },
    }

    /// Records every emit into a vector so tests can assert on the event stream.
    struct CapturingEmitter {
        events: Mutex<Vec<CapturedEvent>>,
    }

    impl CapturingEmitter {
        fn new() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
            }
        }
        fn snapshot(&self) -> Vec<CapturedEvent> {
            self.events.lock().clone()
        }
        fn clear(&self) {
            self.events.lock().clear();
        }
        fn statuses_for(&self, id: DocumentId) -> Vec<CompileStatus> {
            self.snapshot()
                .into_iter()
                .filter_map(|e| match e {
                    CapturedEvent::Status { id: eid, status, .. } if eid == id => Some(status),
                    _ => None,
                })
                .collect()
        }
        /// Revisions of all `compiled` events for `id`, in emit order.
        fn compiled_revisions_for(&self, id: DocumentId) -> Vec<u64> {
            self.snapshot()
                .into_iter()
                .filter_map(|e| match e {
                    CapturedEvent::Compiled { id: eid, revision, .. } if eid == id => Some(revision),
                    _ => None,
                })
                .collect()
        }
        /// Conflict states emitted for `id`, in emit order.
        fn conflicts_for(&self, id: DocumentId) -> Vec<ConflictState> {
            self.snapshot()
                .into_iter()
                .filter_map(|e| match e {
                    CapturedEvent::Conflict { id: eid, conflict, .. } if eid == id => Some(conflict),
                    _ => None,
                })
                .collect()
        }
    }

    impl Emitter for CapturingEmitter {
        fn emit_compiled(
            &self,
            id: DocumentId,
            revision: u64,
            pages: Vec<String>,
            line_map: Vec<LineRect>,
            outline: Vec<crate::domain::outline::OutlineNode>,
            duration_ms: u64,
        ) {
            self.events.lock().push(CapturedEvent::Compiled {
                id,
                revision,
                pages,
                line_map,
                outline,
                duration_ms,
            });
        }
        fn emit_diagnostics(&self, id: DocumentId, revision: u64, diagnostics: Vec<Diagnostic>) {
            self.events
                .lock()
                .push(CapturedEvent::Diagnostics { id, revision, diagnostics });
        }
        fn emit_status(
            &self,
            id: DocumentId,
            revision: u64,
            status: CompileStatus,
            duration_ms: Option<u64>,
        ) {
            self.events
                .lock()
                .push(CapturedEvent::Status { id, revision, status, duration_ms });
        }
        fn emit_conflict(
            &self,
            id: DocumentId,
            revision: u64,
            conflict: ConflictState,
            disk_content: Option<String>,
        ) {
            self.events
                .lock()
                .push(CapturedEvent::Conflict { id, revision, conflict, disk_content });
        }
    }

    /// Build an `EditorService` backed by a capturing emitter.
    fn make_service() -> (EditorService, Arc<CapturingEmitter>) {
        let emitter = Arc::new(CapturingEmitter::new());
        let svc = EditorService::new(emitter.clone());
        (svc, emitter)
    }

    /// Poll the emitter until a `compiled` event for `id` shows up (or panic
    /// after a timeout). Needed because `new_tab` compiles asynchronously on
    /// the worker thread.
    fn wait_for_compiled(emitter: &CapturingEmitter, id: DocumentId) {
        for _ in 0..60 {
            let got = emitter
                .snapshot()
                .iter()
                .any(|e| matches!(e, CapturedEvent::Compiled { id: eid, .. } if *eid == id));
            if got {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("no compiled event for {id} within timeout");
    }

    // --- tests ---------------------------------------------------------------

    #[test]
    fn new_tab_returns_unique_ids() {
        let (svc, _) = make_service();
        let a = svc.new_tab(None);
        let b = svc.new_tab(None);
        let c = svc.new_tab(None);
        assert_ne!(a.id, b.id);
        assert_ne!(b.id, c.id);
        assert_ne!(a.id, c.id);
        assert_eq!(svc.list_tabs().len(), 3);
    }

    #[test]
    fn new_tab_compiles_and_emits_compiled() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        wait_for_compiled(&emitter, meta.id);
        // The default template compiles cleanly → a compiled event is emitted.
        let compiled = emitter.snapshot().into_iter().any(|e| {
            matches!(e, CapturedEvent::Compiled { id, .. } if id == meta.id)
        });
        assert!(compiled, "expected a compiled event for the new tab");
        let statuses = emitter.statuses_for(meta.id);
        assert!(statuses.contains(&CompileStatus::Compiling));
        assert!(statuses.contains(&CompileStatus::Success));
        assert!(svc.last_doc(meta.id).is_some());
    }

    #[test]
    fn multi_tab_compile_isolation() {
        // R2: each tab must compile against its own world independently.
        let (svc, emitter) = make_service();
        let one = svc.new_tab(Some("#set page(width: 10cm)\n\nTab One".into()));
        let two = svc.new_tab(Some("#set page(width: 10cm)\n\nTab Two".into()));

        assert_ne!(one.id, two.id);

        // Wait for both tabs to finish their initial async compiles.
        wait_for_compiled(&emitter, one.id);
        wait_for_compiled(&emitter, two.id);

        // Each tab has its own document.
        let doc1 = svc.last_doc(one.id).expect("tab one should have a document");
        let doc2 = svc.last_doc(two.id).expect("tab two should have a document");
        assert!(
            !doc1.pages().is_empty() && !doc2.pages().is_empty(),
            "both tabs should produce pages"
        );

        // Compiling one tab must not affect the other's result.
        svc.compile_now(one.id);
        let doc2_after = svc.last_doc(two.id).expect("tab two document must persist");
        assert_eq!(
            doc2_after.pages().len(),
            doc2.pages().len(),
            "recompiling tab one must not disturb tab two"
        );

        // Both ids appear in the compiled event stream.
        let ids: Vec<DocumentId> = emitter
            .snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Compiled { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        assert!(ids.contains(&one.id) && ids.contains(&two.id));
    }

    #[test]
    fn update_text_schedules_compile() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        emitter.clear(); // drop the initial-compile events.

        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited content".into())
            .unwrap();

        // The compile runs after the 300ms debounce on the scheduler's runtime.
        // Poll the emitter until the expected event shows up (or time out).
        let mut seen_compiled = false;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let got = emitter
                .snapshot()
                .iter()
                .any(|e| matches!(e, CapturedEvent::Compiled { id, .. } if *id == meta.id));
            if got {
                seen_compiled = true;
                break;
            }
        }
        assert!(seen_compiled, "debounced compile should emit `compiled`");

        let statuses = emitter.statuses_for(meta.id);
        assert!(statuses.contains(&CompileStatus::Compiling));
        assert!(statuses.contains(&CompileStatus::Success));
    }

    #[test]
    fn failing_source_emits_diagnostics() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        emitter.clear();

        svc.update_text(meta.id, "#assert(false)\n".into()).unwrap();
        // Wait for the debounced compile.
        for _ in 0..20 {
            if emitter
                .snapshot()
                .iter()
                .any(|e| matches!(e, CapturedEvent::Diagnostics { id, .. } if *id == meta.id))
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let diags = svc.get_diagnostics(meta.id);
        assert!(!diags.is_empty(), "failing source should yield diagnostics");
        let statuses = emitter.statuses_for(meta.id);
        assert!(statuses.contains(&CompileStatus::Error));
    }

    #[test]
    fn close_tab_releases_state() {
        let (svc, _) = make_service();
        let meta = svc.new_tab(None);
        assert_eq!(svc.list_tabs().len(), 1);
        svc.close_tab(meta.id).unwrap();
        assert!(svc.list_tabs().is_empty());
        assert!(svc.last_doc(meta.id).is_none());
        // Closing an unknown tab errors.
        assert!(svc.close_tab(DocumentId::new()).is_err());
    }

    #[test]
    fn save_file_writes_and_clears_dirty() {
        let tmp = std::env::temp_dir().join(format!("typst-studio-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nOriginal").unwrap();
        let (svc, _) = make_service();
        // Simulate what the command layer does: read content, open tab, then save.
        let initial = std::fs::read_to_string(&tmp).unwrap();
        let meta = svc.open_from_content(tmp.clone(), initial, None).unwrap();
        // Edit + prepare_save + write + clear_dirty (mirrors the async command).
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nSaved!".into())
            .unwrap();
        let (path, text) = svc.prepare_save(meta.id).unwrap();
        std::fs::write(&path, text).unwrap();
        svc.clear_dirty(meta.id);
        let on_disk = std::fs::read_to_string(&tmp).unwrap();
        assert!(on_disk.contains("Saved!"));
        assert!(!svc.tab_meta(meta.id).unwrap().dirty, "dirty flag must clear on save");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn set_dirty_round_trips_and_is_noop_for_missing_tab() {
        // set_dirty is used on session restore to re-mark a doc that was dirty
        // at shutdown. Verify it sets + clears, and is a no-op for an unknown id.
        let tmp = std::env::temp_dir().join(format!("typst-setdirty-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nX").unwrap();
        let (svc, _) = make_service();
        let meta = svc.open_from_content(tmp.clone(), "x".into(), None).unwrap();
        // A freshly opened file is clean.
        assert!(!svc.tab_meta(meta.id).unwrap().dirty);
        // Mark dirty (as restore would for a doc that had unsaved edits at shutdown).
        svc.set_dirty(meta.id, true);
        assert!(svc.tab_meta(meta.id).unwrap().dirty, "set_dirty(true) must mark dirty");
        // Clearing via set_dirty mirrors the boolean toggle.
        svc.set_dirty(meta.id, false);
        assert!(!svc.tab_meta(meta.id).unwrap().dirty, "set_dirty(false) must clear dirty");
        // No-op on an unknown id (must not panic).
        svc.set_dirty(DocumentId::new(), true);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn mark_saved_keeps_dirty_when_revision_advanced_during_save() {
        // Cross-batch review fix (lost-update race): if an edit lands between
        // the save's write completing and mark_saved, the new edit's dirty flag
        // must NOT be clobbered. mark_saved CASes against saved_revision; if the
        // current revision advanced, dirty stays true (the new edit is unsaved).
        let tmp = std::env::temp_dir().join(format!("typst-cas-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nOriginal").unwrap();
        let (svc, _) = make_service();
        let initial = std::fs::read_to_string(&tmp).unwrap();
        let meta = svc.open_from_content(tmp.clone(), initial, None).unwrap();
        // First edit (revision 1) — this is what gets "saved".
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nSaved!".into()).unwrap();
        let saved_rev = svc.tab_revision(meta.id).unwrap();
        // Simulate the save's write completing, THEN a second edit landing
        // before mark_saved runs (revision advances to 2).
        let (path, text) = svc.prepare_save(meta.id).unwrap();
        std::fs::write(&path, text).unwrap();
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEDITED AFTER SAVE!".into()).unwrap();
        // Now mark_saved for the OLD revision — must NOT clear dirty (revision 2 is unsaved).
        svc.mark_saved(meta.id, saved_rev);
        assert!(
            svc.tab_meta(meta.id).unwrap().dirty,
            "dirty must stay true: the post-save edit (rev 2) is unsaved"
        );
        // And the buffer reflects the newer edit, not the saved one.
        assert!(svc.tab_text(meta.id).unwrap().contains("EDITED AFTER SAVE!"));
        // Sanity: if mark_saved is called with the CURRENT revision, dirty clears.
        let current_rev = svc.tab_revision(meta.id).unwrap();
        svc.mark_saved(meta.id, current_rev);
        assert!(!svc.tab_meta(meta.id).unwrap().dirty, "dirty clears when revision matches");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn save_untitled_errors() {
        let (svc, _) = make_service();
        let meta = svc.new_tab(None);
        assert!(svc.prepare_save(meta.id).is_err(), "untitled tab has no path to save to");
    }

    #[test]
    fn update_text_does_not_block_on_in_flight_compile() {
        // The core lock-contention fix: update_text must NOT block while a
        // compile is in flight on the same tab. The world is compiled without
        // any tab-level lock, so set_text can proceed concurrently.
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(Some(
            "#set page(width: 10cm)\n\nInitial".into(),
        ));
        wait_for_compiled(&emitter, meta.id);

        // Schedule a debounced compile (300ms). Before it fires, push a text
        // update. Both should succeed quickly — if the compile held a lock,
        // update_text would stall until the compile finishes.
        let start = std::time::Instant::now();
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited mid-flight".into())
            .unwrap();
        // Immediately schedule another update (the scheduler debounce resets).
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited again".into())
            .unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 50,
            "update_text must return near-instantly even with compile pending (took {elapsed:?})"
        );

        // Eventually the latest edit compiles.
        // Clear old events and wait for a fresh compile.
        emitter.clear();
        wait_for_compiled(&emitter, meta.id);
        assert!(svc.tab_text(meta.id).unwrap().contains("Edited again"));
    }

    #[test]
    fn update_text_bumps_revision_monotonically() {
        let (svc, _) = make_service();
        let meta = svc.new_tab(None);
        let r0 = svc.tab_revision(meta.id).unwrap();
        svc.update_text(meta.id, "a".into()).unwrap();
        let r1 = svc.tab_revision(meta.id).unwrap();
        svc.update_text(meta.id, "b".into()).unwrap();
        let r2 = svc.tab_revision(meta.id).unwrap();
        assert!(r1 > r0, "revision must increase on edit");
        assert!(r2 > r1, "revision must be strictly monotonic");
    }

    #[test]
    fn compiled_events_carry_revision() {
        // §7: every compile-related event carries the revision it corresponds
        // to, so the frontend can discard stale results.
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(Some("#set page(width: 10cm)\n\nHello".into()));
        wait_for_compiled(&emitter, meta.id);
        // The initial compile (revision 0) must carry revision 0.
        let revs = emitter.compiled_revisions_for(meta.id);
        assert!(revs.contains(&0), "initial compile must carry revision 0, got {revs:?}");
    }

    #[test]
    fn opening_same_canonical_path_dedups() {
        // §4.1 / §8.1: opening the same file twice yields one document.
        let tmp = std::env::temp_dir().join(format!("ts-dedup-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nOne").unwrap();
        let (svc, _) = make_service();
        let first = svc.open_from_content(tmp.clone(), "x".into(), None).unwrap();
        // Open via a different lexical path (`.` component) that canonicalizes
        // to the same file — must NOT create a second document.
        let via_dot = tmp.parent().unwrap().join(".").join(tmp.file_name().unwrap());
        let second = svc.open_from_content(via_dot, "y".into(), None).unwrap();
        assert_eq!(first.id, second.id, "same canonical path must dedup");
        assert_eq!(svc.list_tabs().len(), 1);
        assert_eq!(svc.registry().read().len(), 1);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn save_as_preserves_id_and_rebinds_registry() {
        // §4.1 / §8.3: Save As keeps the DocumentId and updates the canonical
        // path index.
        let dir = std::env::temp_dir().join(format!("ts-saveas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.typ");
        std::fs::write(&src, "#set page(width: 10cm)\n\nA").unwrap();
        let (svc, _) = make_service();
        let meta = svc.open_from_content(src.clone(), "x".into(), None).unwrap();
        let id_before = meta.id;
        // Save As to a new path in the same dir.
        let dst = dir.join("b.typ");
        std::fs::write(&dst, "x").unwrap(); // simulate the command layer's write
        svc.rebind_path(meta.id, dst.clone()).unwrap();
        // Canonicalize for comparison: `temp_dir()` may live under a symlink
        // (macOS `/var` → `/private/var`), and the registry stores canonical paths.
        let src_canon = crate::domain::path::canonicalize_for_identity(&src).unwrap();
        let dst_canon = crate::domain::path::canonicalize_for_identity(&dst).unwrap();
        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "Save As must preserve the DocumentId");
        assert_eq!(after.path.as_deref(), Some(dst_canon.as_path()));
        // Old canonical slot is free; new one is claimed.
        assert_eq!(
            svc.registry().read().find_by_canonical(&src_canon),
            None,
            "old canonical slot must be released after Save As"
        );
        assert_eq!(svc.registry().read().find_by_canonical(&dst_canon), Some(id_before));
        assert_eq!(svc.list_tabs().len(), 1, "still one document after rebind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_as_to_already_open_path_rejected() {
        // §8.3: target already bound to another document → reject, don't merge.
        let dir = std::env::temp_dir().join(format!("ts-conflict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.typ");
        let b = dir.join("b.typ");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "y").unwrap();
        // Canonicalize once — the registry keys on canonical paths, which may
        // differ from the literal `dir.join(...)` if `temp_dir()` is symlinked.
        let a_canon = crate::domain::path::canonicalize_for_identity(&a).unwrap();
        let b_canon = crate::domain::path::canonicalize_for_identity(&b).unwrap();
        let (svc, _) = make_service();
        let meta_a = svc.open_from_content(a.clone(), "x".into(), None).unwrap();
        let meta_b = svc.open_from_content(b.clone(), "y".into(), None).unwrap();
        // Try to Save As b onto a's path → must error.
        let err = svc.rebind_path(meta_b.id, a.clone()).unwrap_err();
        assert!(matches!(err, crate::error::AppError::AlreadyOpen { .. }));
        // Both documents intact.
        assert_eq!(svc.list_tabs().len(), 2);
        assert_eq!(svc.tab_meta(meta_a.id).unwrap().path.as_deref(), Some(a_canon.as_path()));
        assert_eq!(svc.tab_meta(meta_b.id).unwrap().path.as_deref(), Some(b_canon.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loose_file_resolves_same_dir_include() {
        // §4.2: a loose file compiles with a parent-directory-rooted resolver,
        // so a same-dir `#include` resolves (broken before Task A).
        let dir = std::env::temp_dir().join(format!("ts-loose-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#include \"intro.typ\"\n").unwrap();
        std::fs::write(dir.join("intro.typ"), "Intro\n").unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        // The include must resolve → a document with at least one page exists.
        let doc = svc
            .last_doc(meta.id)
            .expect("loose file should compile with same-dir #include");
        assert!(
            !doc.pages().is_empty(),
            "compiled document must have pages"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn included_file_open_as_doc_compiles_from_live_buffer_not_disk() {
        // §15.2 integration test 3 (§5 end): when an #include'd file is ALSO an
        // open document with unsaved edits, the including document's compile must
        // see the OPEN (memory) version, not the disk version.
        let dir = std::env::temp_dir().join(format!("ts-vfs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main_path = dir.join("main.typ");
        let intro_path = dir.join("intro.typ");
        std::fs::write(&main_path, "#include \"intro.typ\"\n").unwrap();
        std::fs::write(&intro_path, "Original\n").unwrap();

        let (svc, emitter) = make_service();
        // Open BOTH files as separate documents in the same directory. They
        // share the parent-rooted resolver AND the shared in-memory VFS.
        let main_content = std::fs::read_to_string(&main_path).unwrap();
        let intro_content = std::fs::read_to_string(&intro_path).unwrap();
        let main_meta = svc
            .open_from_disk(main_path.clone(), main_content, None)
            .unwrap();
        let intro_meta = svc
            .open_from_disk(intro_path.clone(), intro_content, None)
            .unwrap();
        assert_ne!(main_meta.id, intro_meta.id, "two distinct documents");
        wait_for_compiled(&emitter, main_meta.id);
        wait_for_compiled(&emitter, intro_meta.id);

        // Snapshot the main doc rendered to SVG BEFORE the edit, then edit
        // intro.typ in memory (WITHOUT saving) and recompile main.typ. The new
        // render must differ — proving the include picked up the live buffer.
        let render_main = |svc: &EditorService, id| -> String {
            let doc = svc.last_doc(id).expect("main doc present");
            crate::render::svg::SvgRenderer::new().render(&doc).join("\n")
        };
        let svg_before = render_main(&svc, main_meta.id);

        // Edit intro in memory only; do NOT touch the disk file.
        svc.update_text(intro_meta.id, "EditedInMemory\n".to_string())
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&intro_path).unwrap(),
            "Original\n",
            "the disk file must still say Original (edit was memory-only)"
        );
        assert!(svc.tab_meta(intro_meta.id).unwrap().dirty);

        // Recompile main (debounced on the worker). Wait for a fresh compile.
        emitter.clear();
        svc.update_text(main_meta.id, svc.tab_text(main_meta.id).unwrap())
            .unwrap();
        wait_for_compiled(&emitter, main_meta.id);
        let svg_after = render_main(&svc, main_meta.id);

        assert_ne!(
            svg_before, svg_after,
            "main's compile must change when the included file's live buffer changes"
        );
        // If the SVG happens to embed text, assert the edited content shows up
        // (and the disk content does not). On path-based SVG renderers this is
        // a no-op pass — the differs-check above is the authoritative assertion.
        assert!(
            !svg_after.contains("Original") || svg_after.contains("EditedInMemory"),
            "render must not surface the stale disk 'Original' as the live text"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn closing_an_included_doc_falls_back_to_disk() {
        // §5 end corollary: once an included file's document is CLOSED, its VFS
        // entry is removed, so the include falls back to the disk version.
        let dir = std::env::temp_dir().join(format!("ts-vfs-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main_path = dir.join("main.typ");
        let intro_path = dir.join("intro.typ");
        std::fs::write(&main_path, "#include \"intro.typ\"\n").unwrap();
        std::fs::write(&intro_path, "OnDisk\n").unwrap();

        let (svc, emitter) = make_service();
        let main_meta = svc
            .open_from_disk(main_path.clone(), std::fs::read_to_string(&main_path).unwrap(), None)
            .unwrap();
        let intro_meta = svc
            .open_from_disk(intro_path.clone(), std::fs::read_to_string(&intro_path).unwrap(), None)
            .unwrap();
        wait_for_compiled(&emitter, main_meta.id);
        wait_for_compiled(&emitter, intro_meta.id);

        // Edit intro in memory, then CLOSE it. The VFS entry is removed on
        // close, so main's next compile must read the disk "OnDisk" again.
        svc.update_text(intro_meta.id, "OnlyInMemory".to_string()).unwrap();
        svc.close_tab(intro_meta.id).unwrap();

        emitter.clear();
        svc.update_text(main_meta.id, svc.tab_text(main_meta.id).unwrap()).unwrap();
        wait_for_compiled(&emitter, main_meta.id);
        // The doc still compiles (disk intro.typ exists) — the close removed
        // the overlay, so disk is the source of truth again.
        let doc = svc.last_doc(main_meta.id).expect("main doc present after close");
        assert!(!doc.pages().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebind_path_rebuilds_world_and_recompiles() {
        // §8.3 / §4.2: Save As rebuilds the world against the NEW parent dir, so
        // the recompiled document reflects the target's neighbors.
        let dir1 = std::env::temp_dir().join(format!("ts-rebind-1-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir().join(format!("ts-rebind-2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        // Source file includes intro.typ from its own directory.
        let src = dir1.join("main.typ");
        let text = "#include \"intro.typ\"\n";
        std::fs::write(&src, text).unwrap();
        std::fs::write(dir1.join("intro.typ"), "Intro in dir1\n").unwrap();
        // Target directory has its own intro.typ with different content.
        let dst = dir2.join("main.typ");
        std::fs::write(&dst, text).unwrap();
        std::fs::write(dir2.join("intro.typ"), "Intro in dir2\n").unwrap();

        let (svc, emitter) = make_service();
        let meta = svc.open_from_disk(src.clone(), text.to_string(), None).unwrap();
        wait_for_compiled(&emitter, meta.id);

        // Save As into dir2. The buffer + id are preserved, but the world is
        // rebuilt against dir2's parent — so the next compile resolves dir2's
        // intro.typ.
        emitter.clear(); // drop the initial-compile event so the wait below
                         // only returns once the post-rebind compile finishes.
        svc.rebind_path(meta.id, dst.clone()).unwrap();
        wait_for_compiled(&emitter, meta.id);

        // id preserved, registry points at the new canonical path, document
        // compiles (the new include resolved).
        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, meta.id, "Save As must preserve the DocumentId");
        let dst_canon = crate::domain::path::canonicalize_for_identity(&dst).unwrap();
        assert_eq!(after.path.as_deref(), Some(dst_canon.as_path()));
        assert_eq!(
            svc.registry().read().find_by_canonical(&dst_canon),
            Some(meta.id)
        );
        assert!(
            svc.last_doc(meta.id)
                .map(|d| !d.pages().is_empty())
                .unwrap_or(false),
            "rebound tab must recompile to a non-empty document"
        );
        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn rebind_path_preserves_buffer_and_revision() {
        // §4.1 / §7: Save As keeps the in-memory buffer and the revision counter.
        let dir = std::env::temp_dir().join(format!("ts-rebind-buf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.typ");
        std::fs::write(&src, "#set page(width: 10cm)\n\nOriginal").unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&src).unwrap();
        let meta = svc.open_from_disk(src.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        // Edit to bump the revision.
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited".into())
            .unwrap();
        let text_before = svc.tab_text(meta.id).unwrap();
        let rev_before = svc.tab_revision(meta.id).unwrap();
        assert!(rev_before > 0, "edit must have bumped the revision");

        let dst = dir.join("b.typ");
        std::fs::write(&dst, &text_before).unwrap();
        svc.rebind_path(meta.id, dst.clone()).unwrap();
        wait_for_compiled(&emitter, meta.id);

        assert_eq!(
            svc.tab_text(meta.id).as_deref(),
            Some(text_before.as_str()),
            "buffer must survive rebind"
        );
        assert_eq!(
            svc.tab_revision(meta.id),
            Some(rev_before),
            "revision must survive rebind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebind_path_to_already_open_target_rejected() {
        // §8.3: rebinding onto another document's path is rejected; both intact.
        let dir = std::env::temp_dir().join(format!("ts-rebind-conf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.typ");
        let b = dir.join("b.typ");
        std::fs::write(&a, "#set page(width: 10cm)\n\nA").unwrap();
        std::fs::write(&b, "#set page(width: 10cm)\n\nB").unwrap();
        let a_canon = crate::domain::path::canonicalize_for_identity(&a).unwrap();
        let b_canon = crate::domain::path::canonicalize_for_identity(&b).unwrap();
        let (svc, _) = make_service();
        let meta_a = svc.open_from_disk(a.clone(), "x".into(), None).unwrap();
        let meta_b = svc.open_from_disk(b.clone(), "y".into(), None).unwrap();
        // Rebind b onto a's path → conflict.
        let err = svc.rebind_path(meta_b.id, a.clone()).unwrap_err();
        assert!(matches!(err, crate::error::AppError::AlreadyOpen { .. }));
        // Both documents intact at their original paths.
        assert_eq!(svc.list_tabs().len(), 2);
        assert_eq!(
            svc.tab_meta(meta_a.id).unwrap().path.as_deref(),
            Some(a_canon.as_path())
        );
        assert_eq!(
            svc.tab_meta(meta_b.id).unwrap().path.as_deref(),
            Some(b_canon.as_path())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loose_resolver_cache_shares_same_parent() {
        // §4.2: two loose files in the same directory share one cached resolver.
        let dir = std::env::temp_dir().join(format!("ts-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let one = dir.join("one.typ");
        let two = dir.join("two.typ");
        std::fs::write(&one, "#set page(width: 10cm)\n\nOne").unwrap();
        std::fs::write(&two, "#set page(width: 10cm)\n\nTwo").unwrap();
        let (svc, emitter) = make_service();
        let a = svc
            .open_from_disk(one.clone(), "#set page(width: 10cm)\n\nOne".into(), None)
            .unwrap();
        let b = svc
            .open_from_disk(two.clone(), "#set page(width: 10cm)\n\nTwo".into(), None)
            .unwrap();
        wait_for_compiled(&emitter, a.id);
        wait_for_compiled(&emitter, b.id);
        assert_ne!(a.id, b.id, "two distinct files → two distinct docs");
        assert_eq!(
            svc.loose_resolver_cache_len(),
            1,
            "both files share one parent → exactly one cached resolver"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- workspace reclassification (§4.3) -----------------------------------

    /// A no-op fs-change callback for the workspace watcher in tests.
    fn noop_on_change() -> crate::fs::watcher::OnChange {
        Arc::new(|_: &[PathBuf]| {})
    }

    /// §4.3: opening a workspace reclassifies an already-open loose file inside
    /// it to a `WorkspaceFile`, preserving id/buffer/revision and still
    /// compiling.
    #[test]
    fn reclassify_loose_to_workspace_on_open() {
        let dir = std::env::temp_dir().join(format!("ts-recl-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nHello").unwrap();

        let (svc, emitter) = make_service();
        // Open the file with NO workspace → it's a loose file.
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        let id_before = meta.id;
        assert!(
            matches!(meta.origin, crate::domain::document::DocumentOrigin::LooseFile { .. }),
            "without a workspace the file must classify as LooseFile"
        );

        // Open a workspace rooted at the file's dir and reclassify.
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let ws_id = ws.workspace_id().unwrap();
        emitter.clear(); // drop the initial-compile event so the wait below
                         // only returns once the post-reclassify compile finishes.
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "DocumentId must survive reclassify");
        match after.origin {
            crate::domain::document::DocumentOrigin::WorkspaceFile { workspace_id, .. } => {
                assert_eq!(workspace_id, ws_id, "origin must carry the new workspace id");
            }
            ref other => panic!("expected WorkspaceFile, got {other:?}"),
        }
        // Buffer + revision preserved.
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some("#set page(width: 10cm)\n\nHello"));
        assert_eq!(svc.tab_revision(meta.id), Some(0));

        // The rebuilt world still compiles (the worker recompiles).
        wait_for_compiled(&emitter, meta.id);
        assert!(
            svc.last_doc(meta.id).map(|d| !d.pages().is_empty()).unwrap_or(false),
            "reclassified tab must recompile to a non-empty document"
        );
        ws.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3: closing a workspace demotes a `WorkspaceFile` to a `LooseFile`
    /// rooted at its parent dir (so same-dir `#include` still resolves),
    /// preserving id/buffer.
    #[test]
    fn reclassify_workspace_to_loose_on_close() {
        let dir = std::env::temp_dir().join(format!("ts-recl-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        // An include that must keep resolving after demotion (parent-rooted).
        std::fs::write(&main, "#include \"intro.typ\"\n").unwrap();
        std::fs::write(dir.join("intro.typ"), "Intro\n").unwrap();

        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        // Open WITH a workspace → it's a WorkspaceFile.
        let meta = svc.open_from_disk(main.clone(), content, Some(&ws)).unwrap();
        wait_for_compiled(&emitter, meta.id);
        let id_before = meta.id;
        assert!(
            matches!(meta.origin, crate::domain::document::DocumentOrigin::WorkspaceFile { .. }),
            "inside an open workspace the file must classify as WorkspaceFile"
        );

        // Close the workspace and reclassify → demote to LooseFile.
        ws.close();
        emitter.clear();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "DocumentId must survive reclassify");
        match &after.origin {
            crate::domain::document::DocumentOrigin::LooseFile { root, .. } => {
                assert_eq!(root, &crate::domain::path::canonicalize_for_identity(&dir).unwrap());
            }
            other => panic!("expected LooseFile after close, got {other:?}"),
        }
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some("#include \"intro.typ\"\n"));

        // The parent-rooted resolver still resolves the same-dir include.
        wait_for_compiled(&emitter, meta.id);
        assert!(
            svc.last_doc(meta.id).map(|d| !d.pages().is_empty()).unwrap_or(false),
            "demoted loose file must still resolve its same-dir #include"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3 / §7: reclassification preserves `dirty` and `revision` (only Save
    /// As / save clears dirty).
    #[test]
    fn reclassify_preserves_dirty_and_revision() {
        let dir = std::env::temp_dir().join(format!("ts-recl-dirty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nOriginal").unwrap();

        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, Some(&ws)).unwrap();
        wait_for_compiled(&emitter, meta.id);
        // Edit → dirty + bumped revision.
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited".into())
            .unwrap();
        wait_for_compiled(&emitter, meta.id);
        let rev_before = svc.tab_revision(meta.id).unwrap();
        let text_before = svc.tab_text(meta.id).unwrap();
        assert!(rev_before > 0, "edit must have bumped the revision");
        assert!(svc.tab_meta(meta.id).unwrap().dirty, "must be dirty after edit");

        // Close + reclassify → dirty + revision survive.
        ws.close();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(svc.tab_revision(meta.id), Some(rev_before), "revision preserved");
        assert!(after.dirty, "dirty must survive reclassification");
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some(text_before.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3: `Untitled` documents are never reclassified.
    #[test]
    fn reclassify_untitled_untouched() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        wait_for_compiled(&emitter, meta.id);
        let text_before = svc.tab_text(meta.id).unwrap();
        let rev_before = svc.tab_revision(meta.id).unwrap();

        let ws = WorkspaceService::new();
        let dir = std::env::temp_dir().join(format!("ts-recl-unt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        svc.reclassify_documents(&ws);
        ws.close();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert!(
            after.origin.is_untitled(),
            "untitled origin must be untouched by reclassify"
        );
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some(text_before.as_str()));
        assert_eq!(svc.tab_revision(meta.id), Some(rev_before));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3: a loose file OUTSIDE the workspace root stays loose when a
    /// workspace opens.
    #[test]
    fn reclassify_outside_workspace_stays_loose() {
        let ws_dir =
            std::env::temp_dir().join(format!("ts-recl-out-ws-{}", uuid::Uuid::new_v4()));
        let outside_dir =
            std::env::temp_dir().join(format!("ts-recl-out-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();
        let main = outside_dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nOutside").unwrap();

        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        let id_before = meta.id;
        assert!(matches!(meta.origin, crate::domain::document::DocumentOrigin::LooseFile { .. }));

        // Open a workspace that does NOT contain the file → stays loose.
        let ws = WorkspaceService::new();
        ws.open(ws_dir.clone(), noop_on_change()).unwrap();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before);
        assert!(
            matches!(after.origin, crate::domain::document::DocumentOrigin::LooseFile { .. }),
            "file outside the workspace must stay LooseFile"
        );
        ws.close();
        let _ = std::fs::remove_dir_all(&ws_dir);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn reclassify_stale_workspacefile_is_reclaimed_with_new_id() {
        // Open a file as WorkspaceFile(id1), close the workspace (demotes to
        // LooseFile), reopen the SAME folder (new id2), reclassify — the doc
        // must be re-claimed as WorkspaceFile carrying id2 (not left stale).
        let dir = std::env::temp_dir().join(format!("ts-recl-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nStale").unwrap();

        let (svc, emitter) = make_service();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let id1 = ws.workspace_id().expect("workspace open has an id");
        // Open inside the workspace → classifies as WorkspaceFile(id1).
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, Some(&ws)).unwrap();
        wait_for_compiled(&emitter, meta.id);
        match &svc.tab_meta(meta.id).unwrap().origin {
            crate::domain::document::DocumentOrigin::WorkspaceFile { workspace_id, .. } => {
                assert_eq!(*workspace_id, id1, "should be claimed by the first workspace");
            }
            other => panic!("expected WorkspaceFile, got {other:?}"),
        }

        // Close → demote to LooseFile.
        ws.close();
        svc.reclassify_documents(&ws);
        assert!(matches!(
            svc.tab_meta(meta.id).unwrap().origin,
            crate::domain::document::DocumentOrigin::LooseFile { .. }
        ));

        // Reopen the SAME folder → a fresh WorkspaceId.
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let id2 = ws.workspace_id().expect("reopened workspace has an id");
        assert_ne!(id1, id2, "each open must mint a fresh WorkspaceId");
        svc.reclassify_documents(&ws);

        // The doc is re-claimed by the new workspace, carrying id2.
        let id_preserved = meta.id;
        match &svc.tab_meta(meta.id).unwrap().origin {
            crate::domain::document::DocumentOrigin::WorkspaceFile { workspace_id, .. } => {
                assert_eq!(*workspace_id, id2, "stale doc must be re-claimed with the new id");
            }
            other => panic!("expected WorkspaceFile after reopen, got {other:?}"),
        }
        assert_eq!(svc.tab_meta(meta.id).unwrap().id, id_preserved, "DocumentId stable");

        ws.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- external-modification handling (§8.4, Task B2) ---------------------

    /// Create a temp `.typ` file with the given content and return its path.
    fn make_tmp_file(content: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("ts-conflict-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        p
    }

    /// Open a file as a disk-backed tab (clean) and wait for its first compile.
    fn open_clean_file(svc: &EditorService, emitter: &CapturingEmitter, path: &Path) -> DocumentId {
        let content = std::fs::read_to_string(path).unwrap();
        let meta = svc.open_from_disk(path.to_path_buf(), content, None).unwrap();
        wait_for_compiled(emitter, meta.id);
        // Wait for the disk_version to be seeded (open_from_disk sets it after
        // the worker is created; it reads the file synchronously).
        for _ in 0..40 {
            if svc.disk_version_seeded(meta.id) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        meta.id
    }

    /// §8.4: a clean buffer auto-reloads from disk on external change (revision
    /// bumps, dirty stays false, content updates), then recompiles.
    #[test]
    fn handle_external_change_clean_buffer_auto_reloads() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nOriginal");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let rev_before = svc.tab_revision(id).unwrap();
        assert!(!svc.tab_meta(id).unwrap().dirty);

        // Externally modify the file (buffer is clean).
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nChanged on disk").unwrap();
        svc.handle_external_change(&tmp);

        // Buffer reloaded to the new content; revision bumped; still not dirty.
        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some("#set page(width: 10cm)\n\nChanged on disk"),
            "clean buffer must reload from disk"
        );
        assert!(
            svc.tab_revision(id).unwrap() > rev_before,
            "reload must bump the revision"
        );
        assert!(
            !svc.tab_meta(id).unwrap().dirty,
            "auto-reload must not mark the buffer dirty"
        );
        assert_eq!(svc.tab_meta(id).unwrap().conflict, ConflictState::None);
        // The reload signals a recompile.
        emitter.clear();
        wait_for_compiled(&emitter, id);
        let _ = std::fs::remove_file(&tmp);
    }

    /// §8.4: a dirty buffer with an external change enters `Modified` conflict
    /// — the buffer is NEVER clobbered.
    #[test]
    fn handle_external_change_dirty_buffer_enters_conflict() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nOriginal");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        // Dirty the buffer with unsaved edits.
        svc.update_text(id, "#set page(width: 10cm)\n\nMy local edit".into())
            .unwrap();
        wait_for_compiled(&emitter, id);
        let text_before = svc.tab_text(id).unwrap();
        let rev_before = svc.tab_revision(id).unwrap();

        // Externally modify the file — buffer is dirty → conflict, no clobber.
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nChanged on disk").unwrap();
        svc.handle_external_change(&tmp);

        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some(text_before.as_str()),
            "dirty buffer must NOT be clobbered"
        );
        assert_eq!(svc.tab_revision(id), Some(rev_before), "no reload → no revision bump");
        assert_eq!(
            svc.tab_meta(id).unwrap().conflict.tag(),
            ConflictState::Modified { disk_version: None }.tag(),
            "must enter Modified conflict"
        );
        // A conflict event was emitted.
        assert!(
            emitter
                .conflicts_for(id)
                .iter()
                .any(|c| c.tag() == ConflictState::Modified { disk_version: None }.tag()),
            "expected a Modified conflict event"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    /// §8.4: deleting the backing file marks the document `Missing` but
    /// preserves the buffer.
    #[test]
    fn handle_external_change_deleted_file_marks_missing() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nHello");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let text_before = svc.tab_text(id).unwrap();

        // Delete the file then deliver the watcher event.
        std::fs::remove_file(&tmp).unwrap();
        svc.handle_external_change(&tmp);

        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some(text_before.as_str()),
            "buffer must be preserved on deletion"
        );
        assert_eq!(
            svc.tab_meta(id).unwrap().conflict,
            ConflictState::Missing,
            "deleted file must mark Missing"
        );
        assert!(emitter.conflicts_for(id).contains(&ConflictState::Missing));
    }

    /// §8.4 "仅时间戳变化但内容未变": a touch (same bytes, new mtime) must NOT
    /// reload — the revision is unchanged.
    #[test]
    fn handle_external_change_mtime_only_no_reload() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nSame");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let rev_before = svc.tab_revision(id).unwrap();
        let text_before = svc.tab_text(id).unwrap();

        // Rewrite identical bytes after a short sleep to advance the mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nSame").unwrap();
        svc.handle_external_change(&tmp);

        assert_eq!(svc.tab_revision(id), Some(rev_before), "mtime-only change must not bump revision");
        assert_eq!(svc.tab_text(id), Some(text_before), "buffer unchanged");
        assert_eq!(svc.tab_meta(id).unwrap().conflict, ConflictState::None);
        let _ = std::fs::remove_file(&tmp);
    }

    /// §8.2: the app's own save must NOT trigger a conflict/reload. After the
    /// save path (prepare_save → write → mark_saved), the watcher event for our
    /// write compares equal (disk_version matches) → no-op.
    #[test]
    fn self_save_does_not_trigger_conflict() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nOriginal");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        // Edit + save via the same path the command layer uses.
        svc.update_text(id, "#set page(width: 10cm)\n\nSaved!".into())
            .unwrap();
        wait_for_compiled(&emitter, id);
        let (path, text) = svc.prepare_save(id).unwrap();
        std::fs::write(&path, &text).unwrap();
        let saved_rev = svc.tab_revision(id).unwrap();
        svc.mark_saved(id, saved_rev); // records the on-disk version of our write.
        assert!(!svc.tab_meta(id).unwrap().dirty, "mark_saved clears dirty");
        assert_eq!(svc.tab_meta(id).unwrap().conflict, ConflictState::None);

        let rev_before = svc.tab_revision(id).unwrap();
        let text_before = svc.tab_text(id).unwrap();

        // Simulate the watcher firing for our own write.
        svc.handle_external_change(&tmp);

        assert_eq!(
            svc.tab_revision(id),
            Some(rev_before),
            "self-save must not bump the revision"
        );
        assert_eq!(svc.tab_text(id), Some(text_before), "buffer unchanged on self-save");
        assert_eq!(
            svc.tab_meta(id).unwrap().conflict,
            ConflictState::None,
            "self-save must not enter conflict"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    /// §4.2 / §8.4: opening a loose file OUTSIDE the workspace installs a
    /// parent-directory watcher (the workspace watcher does not cover it).
    #[test]
    fn loose_file_watcher_installed_for_out_of_workspace_file() {
        let dir = std::env::temp_dir()
            .join(format!("ts-loose-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nLoose").unwrap();
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &main);
        assert!(
            matches!(svc.tab_meta(id).unwrap().origin, crate::domain::document::DocumentOrigin::LooseFile { .. }),
            "without a workspace the file must be loose"
        );
        assert_eq!(
            svc.loose_watcher_count(),
            1,
            "exactly one parent-dir watcher for the loose file"
        );

        // Behaviourally: a real external change reaches handle_external_change
        // (we call it directly since the watcher's 300ms debounce is timing-
        // dependent and already tested in watcher.rs).
        std::fs::write(&main, "#set page(width: 10cm)\n\nChanged").unwrap();
        svc.handle_external_change(&main);
        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some("#set page(width: 10cm)\n\nChanged"),
            "loose-file external change reloads the clean buffer"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Same-dir loose files share ONE watcher (§4.2 cache sharing for watchers
    /// too), and a second distinct dir gets a second watcher.
    #[test]
    fn loose_watchers_share_same_parent_dir() {
        let dir1 = std::env::temp_dir()
            .join(format!("ts-loose-share-1-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir()
            .join(format!("ts-loose-share-2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        let a = dir1.join("a.typ");
        let b = dir1.join("b.typ");
        let c = dir2.join("c.typ");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "y").unwrap();
        std::fs::write(&c, "z").unwrap();
        let (svc, emitter) = make_service();
        open_clean_file(&svc, &emitter, &a);
        open_clean_file(&svc, &emitter, &b);
        assert_eq!(svc.loose_watcher_count(), 1, "two same-dir files share one watcher");
        open_clean_file(&svc, &emitter, &c);
        assert_eq!(svc.loose_watcher_count(), 2, "a second distinct dir adds a second watcher");
        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn handle_external_change_for_unrelated_path_is_noop() {
        // The workspace watcher routes EVERY changed path through
        // handle_external_change; most don't correspond to an open document and
        // must be silently ignored (no panic, no events, no state change).
        let dir = std::env::temp_dir().join(format!("ts-noop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nUnrelated").unwrap();
        let (svc, emitter) = make_service();
        open_clean_file(&svc, &emitter, &main);
        emitter.clear();

        // A path with no open document — must not panic or emit anything.
        let other = dir.join("notes.typ");
        std::fs::write(&other, "changed").unwrap();
        svc.handle_external_change(&other);
        // Also exercise a totally bogus path.
        svc.handle_external_change(std::path::Path::new("/nonexistent-ts-xyz/none.typ"));

        // No conflict, no compile events for our tab.
        let snaps = emitter.snapshot();
        assert!(
            snaps.iter().all(|e| !matches!(
                e,
                CapturedEvent::Conflict { id, .. } if *id == svc.tab_meta(svc.list_tabs()[0].id).unwrap().id
            )),
            "unrelated path must not raise a conflict: {snaps:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.4: when the backing file becomes unreadable (permission revoked) the
    /// watcher now surfaces `PermissionChanged` instead of silently skipping
    /// (the pre-§5.4 behavior lumped PermissionDenied into the transient-error
    /// skip path). The buffer is preserved.
    #[cfg(unix)]
    #[test]
    fn handle_external_change_permission_revoked_marks_permission_changed() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nSecret");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let text_before = svc.tab_text(id).unwrap();

        // Revoke ALL permissions (0o000) so the next read fails with
        // PermissionDenied (the file still EXISTS — it's just unreadable now).
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Deliver the watcher event.
        svc.handle_external_change(&tmp);

        // Restore perms so cleanup works regardless of the assertion outcome.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644));

        // §5.4: the conflict is PermissionChanged (NOT Missing, NOT skipped).
        let conflict = svc.tab_meta(id).unwrap().conflict;
        assert_eq!(
            conflict.tag(),
            "permission_changed",
            "unreadable file must mark PermissionChanged, got {:?}",
            conflict
        );
        // Buffer preserved.
        assert_eq!(svc.tab_text(id).as_deref(), Some(text_before.as_str()));
        // A conflict event was emitted.
        assert!(
            emitter
                .conflicts_for(id)
                .iter()
                .any(|c| c.tag() == "permission_changed"),
            "expected a PermissionChanged conflict event"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    /// §5.4: an external tool rewrites the file with the SAME bytes but a NEW
    /// inode (e.g. `sed -i`, an atomic write-then-rename). Content equality
    /// holds, but the inode differs → for a DIRTY buffer this is `Replaced`
    /// (conservative: the user has unsaved edits and the file identity changed
    /// under them). The buffer is preserved.
    ///
    /// We synthesize the "same bytes, new inode" case by writing the identical
    /// content to a fresh temp file and then ATOMICALLY MOVING it over the
    /// original (rename-over is the canonical inode-changing rewrite on Unix).
    #[cfg(unix)]
    #[test]
    fn handle_external_change_replaced_same_bytes_new_inode_marks_replaced() {
        let dir = std::env::temp_dir().join(format!("ts-replaced-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "#set page(width: 10cm)\n\nSame content").unwrap();
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &path);

        // Dirty the buffer (unsaved edits) — the Replaced conflict only fires
        // for a dirty buffer; a clean buffer silently re-baselines (bytes match).
        svc.update_text(id, "#set page(width: 10cm)\n\nSame content + my edit".into()).unwrap();
        wait_for_compiled(&emitter, id);
        let text_before = svc.tab_text(id).unwrap();

        // Rewrite the file with the SAME bytes via an atomic rename-over, which
        // mints a new inode. (A plain re-write of identical bytes may keep the
        // same inode depending on the FS, so we use the rename trick that
        // `sed -i` / atomic-save tools use.)
        let staging = dir.join(".doc.typ.staging");
        std::fs::write(&staging, "#set page(width: 10cm)\n\nSame content").unwrap();
        std::fs::rename(&staging, &path).unwrap();

        // Deliver the watcher event.
        svc.handle_external_change(&path);

        // §5.4: same bytes + new inode + dirty → Replaced (NOT a silent no-op,
        // even though the content is identical — the identity changed).
        let conflict = svc.tab_meta(id).unwrap().conflict;
        assert_eq!(
            conflict.tag(),
            "replaced",
            "same bytes + new inode + dirty must mark Replaced, got {:?}",
            conflict
        );
        // Buffer preserved (never clobbered).
        assert_eq!(svc.tab_text(id).as_deref(), Some(text_before.as_str()));
        assert!(
            emitter.conflicts_for(id).iter().any(|c| c.tag() == "replaced"),
            "expected a Replaced conflict event"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
