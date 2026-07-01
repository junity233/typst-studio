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
use crate::domain::diagnostics::{Diagnostic, Range, Severity};
use crate::domain::document::{DocumentId, DocumentMeta};
use crate::error::{AppError, Result};
use crate::ipc::events::CompileStatus;
use crate::render::pipeline::RenderPipeline;
use crate::render::svg::SvgRenderer;
use crate::typst_engine::compiler;

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
pub trait Emitter: Send + Sync {
    /// Notify the frontend of a successful compile with rendered SVG pages.
    fn emit_compiled(&self, id: DocumentId, pages: Vec<String>, duration_ms: u64);
    /// Notify the frontend of compile errors.
    fn emit_diagnostics(&self, id: DocumentId, diagnostics: Vec<Diagnostic>);
    /// Notify the frontend of a compile status transition.
    fn emit_status(&self, id: DocumentId, status: CompileStatus, duration_ms: Option<u64>);
}

/// The multi-tab editor orchestrator.
pub struct EditorService {
    tabs: Tabs,
    workers: Workers,
    emitter: Arc<dyn Emitter>,
}

impl EditorService {
    /// Construct a new service with the given emitter.
    pub fn new(emitter: Arc<dyn Emitter>) -> Self {
        Self {
            tabs: Arc::new(RwLock::new(HashMap::new())),
            workers: Arc::new(RwLock::new(HashMap::new())),
            emitter,
        }
    }

    /// Create a new untitled tab and start its compile worker. Returns
    /// immediately; the initial compile runs on the worker thread.
    pub fn new_tab(&self, content: Option<String>) -> DocumentMeta {
        let text = content.unwrap_or_else(|| DEFAULT_TEMPLATE.to_string());
        let meta = DocumentMeta::new_untitled();
        let id = meta.id;
        let tab = Arc::new(TabState::with_meta(meta.clone(), text));
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        meta
    }

    /// Open a tab from already-read content (the command layer handles IO).
    /// Sets the path + title from `path`. A worker is started for the tab.
    pub fn open_from_content(&self, path: PathBuf, content: String) -> DocumentMeta {
        let meta = DocumentMeta::from_path(path);
        let id = meta.id;
        let tab = Arc::new(TabState::with_meta(meta.clone(), content));
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        meta
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
        Ok(())
    }

    /// Update a tab's source text and signal its worker to recompile. Returns
    /// instantly — `set_text` writes directly to the world's interior RwLock,
    /// and `recompile` is a non-blocking channel send.
    pub fn update_text(&self, id: DocumentId, content: String) -> Result<()> {
        let tab = {
            let tabs = self.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        tab.world.set_text(content);
        tab.state.lock().meta.dirty = true;
        // Signal the worker. If it's busy compiling, the message queues; the
        // worker picks up the latest text when it finishes.
        if let Some(worker) = self.workers.read().get(&id) {
            worker.recompile();
        }
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
    /// Runs inside [`std::panic::catch_unwind`] because the compile executes on
    /// the worker's large-stack thread — without catching, a typst panic would
    /// silently kill the thread and the frontend would see `compiling` forever.
    fn do_compile_for_tab(tab: &Arc<TabState>, emitter: &Arc<dyn Emitter>, id: DocumentId) {
        emitter.emit_status(id, CompileStatus::Compiling, None);

        // Snapshot the text BEFORE compile. If it differs after compile, the
        // user typed during compilation → skip SVG render (the worker will
        // immediately recompile with the latest text).
        let text_before = tab.world.text();

        // Compile WITHOUT holding any tab-level lock.
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            compiler::compile(&tab.world)
        }));

        let (outcome, doc) = match result {
            Ok(pair) => pair,
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>()
                    .map(|s| s.clone())
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
                }
                emitter.emit_diagnostics(id, vec![diag]);
                emitter.emit_status(id, CompileStatus::Error, Some(0));
                return;
            }
        };

        // Store results under a brief lock.
        {
            let mut rt = tab.state.lock();
            rt.last_outcome = outcome.clone();
            rt.last_doc = doc.clone();
        }

        if outcome.success {
            // Always emit (possibly empty) diagnostics so the frontend clears
            // stale error markers from a previous failed compile.
            emitter.emit_diagnostics(id, outcome.errors.clone());

            // Only render SVG if the text didn't change during compile.
            let text_after = tab.world.text();
            if text_before == text_after {
                if let Some(doc) = doc {
                    let pages = SvgRenderer::new().render(&doc);
                    emitter.emit_compiled(id, pages, outcome.duration_ms);
                }
            }
            emitter.emit_status(id, CompileStatus::Success, Some(outcome.duration_ms));
        } else {
            emitter.emit_diagnostics(id, outcome.errors.clone());
            emitter.emit_status(id, CompileStatus::Error, Some(outcome.duration_ms));
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
    #[derive(Clone, Debug)]
    enum CapturedEvent {
        Compiled {
            id: DocumentId,
            pages: Vec<String>,
            duration_ms: u64,
        },
        Diagnostics {
            id: DocumentId,
            diagnostics: Vec<Diagnostic>,
        },
        Status {
            id: DocumentId,
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
    }

    impl Emitter for CapturingEmitter {
        fn emit_compiled(&self, id: DocumentId, pages: Vec<String>, duration_ms: u64) {
            self.events
                .lock()
                .push(CapturedEvent::Compiled { id, pages, duration_ms });
        }
        fn emit_diagnostics(&self, id: DocumentId, diagnostics: Vec<Diagnostic>) {
            self.events
                .lock()
                .push(CapturedEvent::Diagnostics { id, diagnostics });
        }
        fn emit_status(&self, id: DocumentId, status: CompileStatus, duration_ms: Option<u64>) {
            self.events
                .lock()
                .push(CapturedEvent::Status { id, status, duration_ms });
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
            doc1.pages().len() >= 1 && doc2.pages().len() >= 1,
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
        let meta = svc.open_from_content(tmp.clone(), initial);
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
}
