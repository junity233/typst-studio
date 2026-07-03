//! `EditorService` — multi-tab orchestration owning one `EditorWorld` per tab.
//!
//! This is the core of the backend. It owns the [`tabs`](Self::tabs) map (an
//! `Arc<RwLock<HashMap>>` so debounced compile closures can capture clones of
//! just the shared state, avoiding a circular `Arc<EditorService>` reference),
//! a [`CompileScheduler`] for 300ms debounced compiles, and an [`Emitter`]
//! abstraction decoupling it from Tauri's `AppHandle`.
//!
//! ## Compile flow
//!
//! [`update_text`](Self::update_text) updates the world's source and schedules a
//! debounced compile. When the timer fires (or immediately via
//! [`compile_now`](Self::compile_now)), [`do_compile`](Self::do_compile):
//! 1. emits `status: compiling`,
//! 2. locks the tab and runs [`compile`](crate::typst_engine::compiler::compile),
//! 3. stores the outcome + document on the tab,
//! 4. on success renders SVG pages and emits `compiled` + `status: success`,
//!    on failure emits `diagnostics` + `status: error`.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use typst_layout::PagedDocument;

use crate::domain::compile_result::CompileOutcome;
use crate::domain::compile_status::CompileStatus;
use crate::domain::diagnostics::{Diagnostic, Range, Severity};
use crate::domain::document::{DocumentId, DocumentMeta, WorkspaceId};
use crate::domain::path::canonicalize_for_identity;
use crate::domain::registry::{DocumentRegistry, SharedRegistry};
use crate::domain::source_map::LineRect;
use crate::error::{AppError, Result};
use crate::render::pipeline::RenderPipeline;
use crate::render::source_map::build_source_map;
use crate::render::svg::SvgRenderer;
use crate::typst_engine::compiler;
use crate::typst_engine::world::EditorWorld;

use super::compile_worker::CompileWorker;
use super::tab_state::TabState;

/// Default content for a fresh untitled tab.
const DEFAULT_TEMPLATE: &str = "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

/// Shared tab map. The world is NOT behind a per-tab Mutex (it has its own
/// interior `RwLock<Source>`), so compile can proceed without holding any
/// tab-level lock — eliminating contention between typing and compiling.
type Tabs = Arc<RwLock<HashMap<DocumentId, Arc<TabState>>>>;
/// Per-tab compile workers (one long-lived thread each).
type Workers = Arc<RwLock<HashMap<DocumentId, CompileWorker>>>;

/// Decouples `EditorService` from the concrete event-delivery mechanism.
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
}

/// The multi-tab editor orchestrator.
pub struct EditorService {
    tabs: Tabs,
    workers: Workers,
    registry: SharedRegistry,
    emitter: Arc<dyn Emitter>,
}

impl EditorService {
    /// Construct a new service with the given emitter.
    pub fn new(emitter: Arc<dyn Emitter>) -> Self {
        Self {
            tabs: Arc::new(RwLock::new(HashMap::new())),
            workers: Arc::new(RwLock::new(HashMap::new())),
            registry: Arc::new(RwLock::new(DocumentRegistry::new())),
            emitter,
        }
    }

    /// Read-only access to the document registry (for the IPC layer to detect
    /// "already open" before creating a duplicate).
    pub fn registry(&self) -> &SharedRegistry {
        &self.registry
    }

    /// Create a new untitled tab and start its compile worker. Returns
    /// immediately; the initial compile runs on the worker thread.
    pub fn new_tab(&self, content: Option<String>) -> DocumentMeta {
        let text = content.unwrap_or_else(|| DEFAULT_TEMPLATE.to_string());
        let meta = DocumentMeta::new_untitled();
        let id = meta.id;
        // Untitled docs carry no canonical path, so the registry never rejects
        // them (multiple untitleds coexist).
        self.registry
            .write()
            .register(meta.clone())
            .expect("untitled registration cannot conflict");
        let tab = Arc::new(TabState::with_meta(meta.clone(), text));
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        meta
    }

    /// Open a tab from already-read content (the command layer handles IO).
    /// Sets the path + title from `path`. A worker is started for the tab.
    ///
    /// If a document at `path`'s canonical location is already open, **no new
    /// document is created**: the existing [`DocumentId`] is returned so the
    /// caller can focus its view instead (§4.1 uniqueness, §8.1 step 3).
    pub fn open_from_content(&self, path: PathBuf, content: String) -> Result<DocumentMeta> {
        let canon = canonicalize_for_identity(&path)?;
        if let Some(existing) = self.find_existing(&canon) {
            return Ok(existing);
        }
        let meta = self.classify_new(DocumentId::new(), canon);
        let id = meta.id;
        self.registry.write().register(meta.clone())?;
        let tab = Arc::new(TabState::with_meta(meta.clone(), content));
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        Ok(meta)
    }

    /// Open a tab backed by a real file in a workspace, so it compiles with
    /// `#include` / `#image()` resolution against the workspace root. Like
    /// [`open_from_content`](Self::open_from_content) but builds the world with
    /// the given [`FileResolver`]. Falls back to a detached world if the
    /// resolver can't anchor the path (e.g. outside the root).
    ///
    /// Deduplicates by canonical path like [`open_from_content`](Self::open_from_content).
    pub fn open_from_disk(
        &self,
        path: PathBuf,
        content: String,
        resolver: Option<crate::fs::FileResolver>,
    ) -> Result<DocumentMeta> {
        let canon = canonicalize_for_identity(&path)?;
        if let Some(existing) = self.find_existing(&canon) {
            return Ok(existing);
        }
        let meta = self.classify_new(DocumentId::new(), canon.clone());
        let id = meta.id;
        self.registry.write().register(meta.clone())?;
        let tab = match resolver {
            Some(r) => match EditorWorld::with_resolver(
                content.clone(),
                crate::typst_engine::font_loader::SystemFontLoader::new(),
                r,
                &canon,
            ) {
                Ok(world) => Arc::new(TabState::with_meta_and_world(meta.clone(), world)),
                // Resolver couldn't anchor the path — degrade to detached.
                Err(_) => Arc::new(TabState::with_meta(meta.clone(), content)),
            },
            None => Arc::new(TabState::with_meta(meta.clone(), content)),
        };
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        Ok(meta)
    }

    /// Return the existing metadata for an already-open canonical path, if any.
    /// Used by the open path to deduplicate before creating a new document.
    fn find_existing(&self, canon: &std::path::Path) -> Option<DocumentMeta> {
        let reg = self.registry.read();
        reg.find_by_canonical(canon)
            .and_then(|id| reg.get(id).cloned())
    }

    /// Classify a fresh on-disk path as `WorkspaceFile` or `LooseFile`. The
    /// active-workspace classification is performed by [`Self::active_workspace_id`];
    /// with no workspace open, every disk file is a `LooseFile` rooted at its
    /// parent directory (§4.2). The full path-containment check lands in
    /// Phase 2 with `WorkspaceService::contains`.
    ///
    /// Phase 1 always classifies as `LooseFile` (parent-rooted) — correct
    /// behavior for the no-workspace case, which is the common path here.
    /// Phase 2 will refine this once `WorkspaceService` exposes containment.
    fn classify_new(&self, id: DocumentId, canon: PathBuf) -> DocumentMeta {
        // Active-workspace containment will be plumbed in Phase 2.
        if let Some(_ws) = self.active_workspace_id() {
            // Reserved for Phase 2: build a WorkspaceFile once containment is
            // queryable. For now, fall through to LooseFile so Phase 1 behavior
            // matches the pre-existing detached-world outcome.
        }
        let root = canon
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        DocumentMeta::with_loose_path(id, canon, root)
    }

    /// The currently active workspace id, if any. Phase 1 always returns `None`
    /// (classification stays `LooseFile`); Phase 2 wires this to
    /// `WorkspaceService`.
    fn active_workspace_id(&self) -> Option<WorkspaceId> {
        None
    }

    /// Assign a new on-disk path to a tab (Save As). Used after writing an
    /// untitled tab to a new file.
    ///
    /// **Phase 1 behavior** (correct enough for the open/close flows):
    /// - Preserves the [`DocumentId`] (§4.1 — id stable across Save As).
    /// - Reclassifies as `LooseFile` rooted at the parent (matching the open
    ///   path). Phase 2 will pick `WorkspaceFile` when the target is inside the
    ///   active workspace.
    /// - Rebids the registry (drops the old canonical slot, claims the new
    ///   one), rejecting the rebind if the target is already another document.
    /// - Clears dirty. No recompile (text unchanged).
    ///
    /// Phase 2 replaces this with `rebind_path`, which also rebuilds the
    /// [`EditorWorld`] with the correct resolver and updates the watcher/LSP.
    pub fn assign_path(&self, id: DocumentId, path: PathBuf) -> Result<()> {
        let tab = {
            let tabs = self.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        // Canonicalize the target. The file now exists (Save As just wrote it).
        let canon = canonicalize_for_identity(&path)?;
        let root = canon
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let new_meta = DocumentMeta::with_loose_path(id, canon, root);
        new_meta.id; // assert field exists; id preserved
        // Rebind the registry first — fails fast on conflict without touching
        // the tab. We re-derive a meta carrying `dirty = false`.
        let new_meta = DocumentMeta {
            dirty: false,
            ..new_meta
        };
        self.registry.write().rebind(id, new_meta.clone())?;
        // Apply to the tab.
        let mut rt = tab.state.lock();
        rt.meta = new_meta;
        rt.meta.dirty = false;
        Ok(())
    }

    /// Spawn a [`CompileWorker`] for `id` whose closure compiles `tab` and
    /// emits results. Signals an initial compile immediately.
    fn create_worker(&self, id: DocumentId, tab: Arc<TabState>) {
        let emitter = self.emitter.clone();
        let compile_fn: Arc<dyn Fn() + Send + Sync> =
            Arc::new(move || Self::do_compile_for_tab(&tab, &emitter, id));
        let worker = CompileWorker::spawn(compile_fn);
        worker.recompile(); // initial compile
        self.workers.write().insert(id, worker);
    }

    /// Close a tab, releasing its world and compile worker. The worker thread
    /// finishes its current compile (if any) then exits in the background —
    /// this method returns immediately.
    pub fn close_tab(&self, id: DocumentId) -> Result<()> {
        // Drop the worker first (sends Shutdown, doesn't join).
        let _ = self.workers.write().remove(&id);
        let removed = self.tabs.write().remove(&id);
        if removed.is_none() {
            return Err(AppError::NotFound(format!("tab {id} not found")));
        }
        // Release the canonical-path slot so the file can be reopened.
        self.registry.write().unregister(id);
        Ok(())
    }

    /// Update a tab's source text and signal its worker to recompile. Returns
    /// instantly — `set_text` writes directly to the world's interior RwLock,
    /// and `recompile` is a non-blocking channel send.
    ///
    /// Bumps the document `revision` atomically with the dirty flag (§7), so
    /// every emitted compile/diagnostic/status event can carry the revision it
    /// corresponds to and stale results can be discarded.
    pub fn update_text(&self, id: DocumentId, content: String) -> Result<()> {
        let tab = {
            let tabs = self.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        tab.world.set_text(content);
        // Atomically bump revision + set dirty under one lock.
        let mut rt = tab.state.lock();
        rt.meta.revision = rt.meta.revision.saturating_add(1);
        let revision = rt.meta.revision;
        rt.meta.dirty = true;
        drop(rt);
        // Signal the worker. If it's busy compiling, the message queues; the
        // worker picks up the latest text when it finishes.
        if let Some(worker) = self.workers.read().get(&id) {
            worker.recompile();
        }
        let _ = revision; // captured by `do_compile_for_tab` via the world read
        Ok(())
    }

    /// Prepare data needed to save a tab: returns `(path, current_text)`. The
    /// command layer does the actual disk write (async). Errors if the tab is
    /// untitled (no path) or missing.
    pub fn prepare_save(&self, id: DocumentId) -> Result<(PathBuf, String)> {
        let tab = {
            let tabs = self.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        let path = tab
            .state
            .lock()
            .meta
            .path
            .clone()
            .ok_or_else(|| AppError::InvalidInput("tab has no on-disk path".into()))?;
        Ok((path, tab.world.text()))
    }

    /// Clear the dirty flag after a successful save.
    pub fn clear_dirty(&self, id: DocumentId) {
        if let Some(t) = self.tabs.read().get(&id) {
            t.state.lock().meta.dirty = false;
        }
    }

    /// Compile a tab synchronously (bypassing the worker). Used in tests.
    pub fn compile_now(&self, id: DocumentId) {
        if let Some(tab) = self.tabs.read().get(&id).cloned() {
            Self::do_compile_for_tab(&tab, &self.emitter, id);
        }
    }

    /// The shared compile pipeline: status → compile (no lock, panic-safe) →
    /// conditionally render → emit.
    ///
    /// **Compile/render separation**: diagnostics are emitted on every compile
    /// (fast feedback), but SVG rendering is **skipped** if the source text
    /// changed during compile (user kept typing). This avoids wasting 1–20 ms
    /// per page on intermediate previews that would be immediately superseded.
    /// The worker model guarantees that after a skipped render, the latest text
    /// is compiled immediately (no debounce delay).
    ///
    /// **Revision tagging (§7)**: the revision is snapshot *before* compile and
    /// stamped onto every emitted event. If the buffer changed mid-compile, the
    /// emitted revision will be the *older* one — the frontend discards it
    /// because a newer revision already won. This replaces relying on event
    /// arrival order for consistency.
    ///
    /// Runs inside [`std::panic::catch_unwind`] because the compile executes on
    /// the worker's large-stack thread — without catching, a typst panic would
    /// silently kill the thread and the frontend would see `compiling` forever.
    fn do_compile_for_tab(tab: &Arc<TabState>, emitter: &Arc<dyn Emitter>, id: DocumentId) {
        // Snapshot revision + text before compile. The revision is the
        // authoritative "this compile corresponds to" stamp.
        let (revision, text_before) = {
            let rt = tab.state.lock();
            (rt.meta.revision, tab.world.text())
        };
        emitter.emit_status(id, revision, CompileStatus::Compiling, None);

        // Compile WITHOUT holding any tab-level lock.
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            compiler::compile(&tab.world)
        }));

        let (outcome, doc) = match result {
            Ok(pair) => pair,
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>().cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown compiler panic".to_string());
                let diag = Diagnostic {
                    severity: Severity::Error,
                    range: Range {
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: 1,
                    },
                    message: format!("Internal compiler error: {msg}"),
                    code: None,
                };
                {
                    let mut rt = tab.state.lock();
                    rt.last_outcome = CompileOutcome::fail(vec![diag.clone()], 0);
                    rt.last_doc = None;
                    rt.last_compiled_revision = Some(revision);
                }
                emitter.emit_diagnostics(id, revision, vec![diag]);
                emitter.emit_status(id, revision, CompileStatus::Error, Some(0));
                return;
            }
        };

        // Store results under a brief lock.
        {
            let mut rt = tab.state.lock();
            rt.last_outcome = outcome.clone();
            rt.last_doc = doc.clone();
            rt.last_compiled_revision = Some(revision);
        }

        if outcome.success {
            // Always emit (possibly empty) diagnostics so the frontend clears
            // stale error markers from a previous failed compile.
            emitter.emit_diagnostics(id, revision, outcome.errors.clone());

            // Only render SVG if the text didn't change during compile.
            let text_after = tab.world.text();
            if text_before == text_after {
                if let Some(doc) = doc {
                    let pages = SvgRenderer::new().render(&doc);
                    // Build the source map from the same compiled document. This
                    // is cheap (one frame walk, KB-scale output) and runs on the
                    // compile thread, so it never blocks the editor. Skipped
                    // alongside SVG when the user kept typing — staying in lock
                    // step with the rendered pages.
                    let line_map = build_source_map(&doc, &tab.world);
                    emitter.emit_compiled(id, revision, pages, line_map, outcome.duration_ms);
                }
            }
            emitter.emit_status(id, revision, CompileStatus::Success, Some(outcome.duration_ms));
        } else {
            emitter.emit_diagnostics(id, revision, outcome.errors.clone());
            emitter.emit_status(id, revision, CompileStatus::Error, Some(outcome.duration_ms));
        }
    }

    // --- accessors -----------------------------------------------------------

    /// Current diagnostics for a tab (empty if the tab or last outcome has none).
    pub fn get_diagnostics(&self, id: DocumentId) -> Vec<Diagnostic> {
        self.tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().last_outcome.errors.clone())
            .unwrap_or_default()
    }

    /// The last successfully compiled document for a tab (for export).
    pub fn last_doc(&self, id: DocumentId) -> Option<PagedDocument> {
        self.tabs
            .read()
            .get(&id)
            .and_then(|t| t.state.lock().last_doc.clone())
    }

    /// Metadata for a single tab, if present.
    pub fn tab_meta(&self, id: DocumentId) -> Option<DocumentMeta> {
        self.tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().meta.clone())
    }

    /// The current content revision for a tab (§7). Bumped on every
    /// [`update_text`](Self::update_text). `None` if the tab is not open.
    pub fn tab_revision(&self, id: DocumentId) -> Option<u64> {
        self.tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().meta.revision)
    }

    /// Metadata for all open tabs (for a tab-list / sidebar).
    pub fn list_tabs(&self) -> Vec<DocumentMeta> {
        self.tabs
            .read()
            .values()
            .map(|t| t.state.lock().meta.clone())
            .collect()
    }

    /// Current source text of a tab (the in-memory buffer, possibly dirty).
    pub fn tab_text(&self, id: DocumentId) -> Option<String> {
        self.tabs.read().get(&id).map(|t| t.world.text())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    }

    impl Emitter for CapturingEmitter {
        fn emit_compiled(
            &self,
            id: DocumentId,
            revision: u64,
            pages: Vec<String>,
            line_map: Vec<LineRect>,
            duration_ms: u64,
        ) {
            self.events.lock().push(CapturedEvent::Compiled {
                id,
                revision,
                pages,
                line_map,
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
        let meta = svc.open_from_content(tmp.clone(), initial).unwrap();
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
        let first = svc.open_from_content(tmp.clone(), "x".into()).unwrap();
        // Open via a different lexical path (`.` component) that canonicalizes
        // to the same file — must NOT create a second document.
        let via_dot = tmp.parent().unwrap().join(".").join(tmp.file_name().unwrap());
        let second = svc.open_from_content(via_dot, "y".into()).unwrap();
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
        let meta = svc.open_from_content(src.clone(), "x".into()).unwrap();
        let id_before = meta.id;
        // Save As to a new path in the same dir.
        let dst = dir.join("b.typ");
        std::fs::write(&dst, "x").unwrap(); // simulate the command layer's write
        svc.assign_path(meta.id, dst.clone()).unwrap();
        // Canonicalize for comparison: `temp_dir()` may live under a symlink
        // (macOS `/var` → `/private/var`), and the registry stores canonical paths.
        let src_canon = canonicalize_for_identity(&src).unwrap();
        let dst_canon = canonicalize_for_identity(&dst).unwrap();
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
        let a_canon = canonicalize_for_identity(&a).unwrap();
        let b_canon = canonicalize_for_identity(&b).unwrap();
        let (svc, _) = make_service();
        let meta_a = svc.open_from_content(a.clone(), "x".into()).unwrap();
        let meta_b = svc.open_from_content(b.clone(), "y".into()).unwrap();
        // Try to Save As b onto a's path → must error.
        let err = svc.assign_path(meta_b.id, a.clone()).unwrap_err();
        assert!(matches!(err, AppError::AlreadyOpen { .. }));
        // Both documents intact.
        assert_eq!(svc.list_tabs().len(), 2);
        assert_eq!(svc.tab_meta(meta_a.id).unwrap().path.as_deref(), Some(a_canon.as_path()));
        assert_eq!(svc.tab_meta(meta_b.id).unwrap().path.as_deref(), Some(b_canon.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
