//! `CompileService` — per-document compile orchestration (§6.3).
//!
//! The compile half of the Phase 4 editor-service split. Each open document has
//! a [`CompileSession`]-equivalent here: a long-lived [`CompileWorker`] thread,
//! the shared [`EditorWorld`](crate::typst_engine::world::EditorWorld) it reads
//! from (held in the document's `TabState`), and the last successful
//! document + diagnostics (revision-stamped, so stale results are discarded).
//!
//! Responsibilities (§6.3):
//! - compile scheduling + coalescing (delegated to [`CompileWorker`]'s
//!   message-coalescing channel),
//! - revision guarding (the compile pipeline snapshots the revision *before*
//!   compile and stamps it onto every emitted event),
//! - rendering (SVG pages + source map, skipped when the buffer changed
//!   mid-compile),
//! - export-bound-to-revision result accessors.
//!
//! ## Split shape
//!
//! Like [`DocumentService`], this service references the shared
//! [`TabStore`](super::tab_store::TabStore) — compile reads the live buffer from
//! `tab.world` and writes results back to `tab.state`, both of which live in the
//! store's `tabs` map. The `workers` map is owned jointly: the compile service
//! spawns/rotates them and signals recompiles; the document service rotates a
//! worker when a document's origin changes (Save As, reclassify). See the
//! [`TabStore`] docs for why the split is structural rather than hermetic on the
//! first pass.
//!
//! [`DocumentService`]: super::document_service::DocumentService

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use typst_layout::PagedDocument;

use crate::domain::compile_result::CompileOutcome;
use crate::domain::compile_status::CompileStatus;
use crate::domain::diagnostics::{Diagnostic, Range, Severity};
use crate::domain::document::DocumentId;
use crate::render::pipeline::RenderPipeline;
use crate::render::source_map::build_source_map;
use crate::render::svg::SvgRenderer;
use crate::typst_engine::compiler;

use super::compile_worker::CompileWorker;
use super::editor_service::{CompileState, Emitter};
use super::tab_state::TabState;
use super::tab_store::TabStore;

/// The compile half of the editor (§6.3).
///
/// Owns (via the shared [`TabStore`]) the per-document worker map and exposes
/// the compile + result-accessor surface. Worker rotation hooks
/// ([`create_worker`](Self::create_worker)) are called by
/// [`DocumentService`](super::document_service::DocumentService) when a
/// document's origin changes — the one unavoidable coupling between the two
/// halves, documented on [`TabStore`].
pub struct CompileService {
    pub(crate) store: TabStore,
}

impl CompileService {
    /// Construct a compile service sharing the same store as its sibling
    /// document service.
    pub fn new(store: TabStore) -> Self {
        Self { store }
    }

    /// Spawn a [`CompileWorker`] for `id` whose closure compiles `tab` and
    /// emits results. Signals an initial compile immediately.
    ///
    /// Called by [`DocumentService`](super::document_service::DocumentService)
    /// on open and on every origin-changing world rebuild (Save As, reclassify).
    pub(crate) fn create_worker(&self, id: DocumentId, tab: Arc<TabState>) {
        let emitter = self.store.emitter.clone();
        let compile_fn: Arc<dyn Fn() + Send + Sync> =
            Arc::new(move || Self::do_compile_for_tab(&tab, &emitter, id));
        let worker = CompileWorker::spawn(compile_fn);
        worker.recompile(); // initial compile
        self.store.workers.write().insert(id, worker);
    }

    /// Compile a tab synchronously (bypassing the worker). Used in tests.
    pub fn compile_now(&self, id: DocumentId) {
        if let Some(tab) = self.store.tabs.read().get(&id).cloned() {
            Self::do_compile_for_tab(&tab, &self.store.emitter, id);
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
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| compiler::compile(&tab.world)));

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

    // --- revision-aware result accessors (§9 export pinning) ----------------

    /// Current diagnostics for a tab (empty if the tab or last outcome has none).
    pub fn get_diagnostics(&self, id: DocumentId) -> Vec<Diagnostic> {
        self.store
            .tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().last_outcome.errors.clone())
            .unwrap_or_default()
    }

    /// The last successfully compiled document for a tab (for export).
    pub fn last_doc(&self, id: DocumentId) -> Option<PagedDocument> {
        self.store
            .tabs
            .read()
            .get(&id)
            .and_then(|t| t.state.lock().last_doc.clone())
    }

    /// A point-in-time snapshot of a tab's last compile result (§9): the
    /// revision that compile corresponds to, its success flag, the rendered
    /// document (if any), and the error diagnostics. Used by export to pin
    /// results to the revision the user is looking at — never silently
    /// returning an older doc. `None` if the tab is not open.
    pub fn last_compile_state(&self, id: DocumentId) -> Option<CompileState> {
        let tab = self.store.tabs.read().get(&id).cloned()?;
        let rt = tab.state.lock();
        Some(CompileState {
            last_compiled_revision: rt.last_compiled_revision,
            success: rt.last_outcome.success,
            doc: rt.last_doc.clone(),
            errors: rt.last_outcome.errors.clone(),
        })
    }
}
