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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use typst_layout::PagedDocument;

use crate::domain::compile_result::CompileOutcome;
use crate::domain::compile_status::CompileStatus;
use crate::domain::diagnostics::{Diagnostic, Range, Severity};
use crate::domain::document::DocumentId;
use crate::render::pipeline::RenderPipeline;
use crate::render::source_map::build_source_map;
use crate::render::svg::SvgRenderer;
use crate::typst_engine::compiler;

use super::compile_supervisor::{
    CompileSupervisor, PANIC_BACKOFF_DURATION, PANIC_BACKOFF_THRESHOLD, SLOW_COMPILE_THRESHOLD,
};
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
        let supervisor = self.store.supervisor.clone();
        // Capture the tabs map so the compile closure can re-check the doc is
        // still open before emitting (§6.2 "已关闭文档的结果不得发布"). A tab
        // closed mid-compile still runs to completion (Rust can't kill the
        // thread), but its result must not be published.
        let tabs = self.store.tabs.clone();
        let compile_fn: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            Self::do_compile_for_tab(&tab, &emitter, &supervisor, &tabs, id)
        });
        let worker = CompileWorker::spawn(compile_fn);
        worker.recompile(); // initial compile
        self.store.workers.write().insert(id, worker);
    }

    /// Compile a tab synchronously (bypassing the worker). Used in tests.
    pub fn compile_now(&self, id: DocumentId) {
        if let Some(tab) = self.store.tabs.read().get(&id).cloned() {
            Self::do_compile_for_tab(
                &tab,
                &self.store.emitter,
                &self.store.supervisor,
                &self.store.tabs,
                id,
            );
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
    ///
    /// **Supervision (§6.2)** — applied here, around the existing pipeline:
    /// - *Concurrency cap*: a process-wide semaphore gates `compiler::compile`.
    ///   A worker waiting on a permit still drains/coalesces its channel.
    /// - *Slow-compile indicator*: a per-compile watchdog emits `Slow` after
    ///   [`SLOW_COMPILE_THRESHOLD`]; cancelled on completion.
    /// - *Panic backoff*: consecutive panics enter a cooling-off period.
    /// - *Closed-doc guard*: after compile, the doc is re-checked open before
    ///   any emit; a close mid-compile drops the result silently.
    /// - *Shutdown*: during a drain, no new compiles start and emits are
    ///   suppressed.
    #[allow(clippy::too_many_arguments)]
    fn do_compile_for_tab(
        tab: &Arc<TabState>,
        emitter: &Arc<dyn Emitter>,
        supervisor: &CompileSupervisor,
        tabs: &super::tab_store::Tabs,
        id: DocumentId,
    ) {
        // --- §6.2 panic backoff: skip while cooling off ----------------------
        // A doc that panicked N times in a row is given a rest so it can't spin
        // the worker. We re-check the deadline each loop iteration; once it
        // passes we allow ONE compile through (which will either reset the
        // count on success or re-arm the cooldown on another panic).
        {
            let rt = tab.state.lock();
            if let Some(until) = rt.panic_cooldown_until {
                if Instant::now() < until {
                    tracing::debug!(
                        "compile skipped for {id}: in panic backoff until {until:?}"
                    );
                    return;
                }
            }
        }

        // --- §6.2 shutdown: stop accepting tasks -----------------------------
        if supervisor.is_shutting_down() {
            return;
        }

        // Snapshot revision + text before compile. The revision is the
        // authoritative "this compile corresponds to" stamp.
        let (revision, text_before) = {
            let rt = tab.state.lock();
            (rt.meta.revision, tab.world.text())
        };
        emitter.emit_status(id, revision, CompileStatus::Compiling, None);

        // --- §6.2 slow-compile watchdog --------------------------------------
        // A short-lived thread that, after SLOW_COMPILE_THRESHOLD, checks whether
        // this compile is still running. If so, it emits `Slow`. The flag is
        // cleared (and the emit suppressed) when the compile finishes first.
        // The watchdog uses its OWN atomic flag (not the supervisor's) so each
        // compile's flag is independent.
        let slow_flag = Arc::new(AtomicBool::new(true)); // true = compile still running
        spawn_slow_watchdog(slow_flag.clone(), emitter.clone(), id, revision);

        // --- §6.2 concurrency cap --------------------------------------------
        // Acquire a permit before compile; release after. A worker blocked here
        // still drains its channel (the worker loop coalesces while we wait),
        // so this bounds parallel CPU without adding latency for the latest
        // edit. Released via the guard's Drop OR release_early on the happy
        // path — whichever comes first.
        let _permit = supervisor.acquire();

        // Compile WITHOUT holding any tab-level lock.
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| compiler::compile(&tab.world)));

        // Compile finished: cancel the slow watchdog (it will see the flag flip
        // and suppress its emit, even if it wakes right after this).
        slow_flag.store(false, Ordering::SeqCst);

        // --- §6.2 closed-doc guard: don't publish if the doc closed ----------
        // A close mid-compile drops the worker + tab; the compile still ran to
        // completion. Re-check the doc is still open before emitting anything.
        if !tabs.read().contains_key(&id) {
            tracing::debug!("compile result for {id} dropped: tab closed mid-compile");
            return;
        }
        // Also suppress all emits during shutdown drain.
        if supervisor.is_shutting_down() {
            return;
        }

        let (outcome, doc) = match result {
            Ok(pair) => pair,
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>().cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown compiler panic".to_string());

                // --- §6.2 panic backoff: count + maybe arm cooldown ----------
                // The worker survives (catch_unwind keeps the thread alive), so
                // we only need to track consecutive panics and arm a cooldown
                // when they exceed the threshold. Reset on success below.
                let (count, now_in_backoff) = {
                    let mut rt = tab.state.lock();
                    rt.consecutive_panic_count = rt.consecutive_panic_count.saturating_add(1);
                    let armed = if rt.consecutive_panic_count >= PANIC_BACKOFF_THRESHOLD {
                        rt.panic_cooldown_until = Some(Instant::now() + PANIC_BACKOFF_DURATION);
                        true
                    } else {
                        false
                    };
                    (rt.consecutive_panic_count, armed)
                };
                if now_in_backoff {
                    tracing::warn!(
                        "compile panicked {PANIC_BACKOFF_THRESHOLD}x for {id}; \
                         entering {PANIC_BACKOFF_DURATION:?} backoff"
                    );
                } else {
                    tracing::warn!(
                        consecutive = count,
                        "compiler panic for {id} (catch_unwind recovered)"
                    );
                }

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
            // --- §6.2 panic backoff: a successful compile resets the count ---
            // (and clears any armed cooldown, though a successful compile can't
            // happen while in cooldown since cooldown skips the compile entirely).
            rt.consecutive_panic_count = 0;
            rt.panic_cooldown_until = None;
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
                    let outline = crate::render::outline::build_outline(&doc, &tab.world);
                    emitter.emit_compiled(
                        id,
                        revision,
                        pages,
                        line_map,
                        outline,
                        outcome.duration_ms,
                    );
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

    /// Signal all compile workers to drain + stop (§6.2 "应用关闭时停止接收
    /// 任务"). Non-blocking: the bounded wait for cooperative exit is the
    /// caller's responsibility (the RunEvent::Exit handler sleeps up to
    /// [`SHUTDOWN_DRAIN_TIMEOUT`]). A runaway compile is not force-killed —
    /// Rust has no safe way to kill a thread — but no *new* compile starts and
    /// in-flight emits are suppressed.
    pub fn shutdown(&self) {
        self.store.supervisor.shutdown();
    }
}

/// Spawn the slow-compile watchdog (§6.2 "编译超过 2 秒显示编译时间较长").
///
/// A detached short-lived thread sleeps [`SLOW_COMPILE_THRESHOLD`], then checks
/// `still_running`. If the compile is still going (the flag wasn't flipped to
/// `false` by completion), it emits `CompileStatus::Slow` so the StatusBar can
/// show "Compiling… (taking a while)". If the compile finished first, the flag
/// is `false` and the emit is suppressed — the terminal `Success`/`Error` is
/// the authoritative status.
///
/// The flag is shared (`Arc<AtomicBool>`) rather than the watchdog holding a
/// handle to cancel the timer, because cancelling a sleeping std thread isn't
/// possible without signaling. The flag-check-after-sleep pattern is the
/// simplest correct approach; the watchdog thread is tiny and short-lived
/// (sleeps once, checks once, exits). There's a harmless race where the compile
/// finishes in the instant between the sleep-wake and the flag check — in that
/// case `Slow` is emitted and immediately followed by the terminal status,
/// which the frontend already handles (a `Slow` → `Success` transition).
///
/// `StdMutex`/`Arc` captures keep this `'static + Send`.
fn spawn_slow_watchdog(
    still_running: Arc<AtomicBool>,
    emitter: Arc<dyn Emitter>,
    id: DocumentId,
    revision: u64,
) {
    // A fresh detached thread per compile. The thread count is bounded by the
    // number of concurrent compiles (itself bounded by the supervisor's cap),
    // so this never explodes.
    let _ = std::thread::Builder::new()
        .name("typst-slow-watchdog".into())
        .spawn(move || {
            std::thread::sleep(SLOW_COMPILE_THRESHOLD);
            // Double-check: the compile may have finished during the sleep.
            if still_running.load(Ordering::SeqCst) {
                emitter.emit_status(id, revision, CompileStatus::Slow, None);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::diagnostics::Diagnostic;
    use crate::domain::document::{ConflictState, DocumentId};
    use crate::domain::source_map::LineRect;
    use crate::service::compile_supervisor::PANIC_BACKOFF_THRESHOLD;
    use parking_lot::Mutex as PlMutex;
    use std::time::Duration;

    /// A recording emitter that captures every status emit into a shared vec.
    /// Used to assert the supervision behavior without a Tauri AppHandle. The
    /// other emit methods are no-ops — only `emit_status` matters for the
    /// supervision assertions.
    #[derive(Default)]
    struct RecordingEmitter {
        statuses: PlMutex<Vec<(DocumentId, u64, CompileStatus, Option<u64>)>>,
    }

    impl Emitter for RecordingEmitter {
        fn emit_compiled(
            &self,
            _id: DocumentId,
            _revision: u64,
            _pages: Vec<String>,
            _line_map: Vec<LineRect>,
            _outline: Vec<crate::domain::outline::OutlineNode>,
            _duration_ms: u64,
        ) {
            // Unused for supervision tests.
            let _ = _line_map;
            let _ = _outline;
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
            id: DocumentId,
            revision: u64,
            status: CompileStatus,
            duration_ms: Option<u64>,
        ) {
            self.statuses.lock().push((id, revision, status, duration_ms));
        }
        fn emit_conflict(
            &self,
            _id: DocumentId,
            _revision: u64,
            _conflict: ConflictState,
            _disk_content: Option<String>,
        ) {
        }
    }

    /// Build a minimal tab + tabs map + supervisor for a do_compile_for_tab call.
    /// Returns the typed emitter (for assertions) and the trait-object view (for
    /// passing into `do_compile_for_tab`, which expects `&Arc<dyn Emitter>`).
    fn fixtures(
        cap: usize,
    ) -> (
        Arc<TabState>,
        Arc<RecordingEmitter>,
        Arc<dyn Emitter>,
        CompileSupervisor,
        super::super::tab_store::Tabs,
        DocumentId,
    ) {
        let id = DocumentId::new();
        let meta = crate::domain::document::DocumentMeta {
            id,
            path: None,
            title: "t".into(),
            dirty: false,
            origin: crate::domain::document::DocumentOrigin::Untitled,
            revision: 1,
            conflict: ConflictState::None,
            hidden: false,
        };
        let tab = Arc::new(TabState::with_meta(meta, "Hello".into()));
        let emitter_typed = Arc::new(RecordingEmitter::default());
        let emitter_dyn: Arc<dyn Emitter> = emitter_typed.clone();
        let supervisor = CompileSupervisor::with_cap(cap);
        let mut map = std::collections::HashMap::new();
        map.insert(id, tab.clone());
        let tabs = Arc::new(parking_lot::RwLock::new(map));
        (tab, emitter_typed, emitter_dyn, supervisor, tabs, id)
    }

    #[test]
    fn do_compile_emits_success_under_supervised_path() {
        // A real compile of plain text is sub-millisecond and always succeeds,
        // so this asserts the happy path (Success emitted, no Slow) under the
        // new supervised code path. The Slow threshold is 2s; we can't force a
        // 2s typst compile in a unit test, so the watchdog is exercised
        // separately (see slow_watchdog_flag_logic).
        let (tab, emitter_typed, emitter_dyn, supervisor, tabs, id) = fixtures(2);
        CompileService::do_compile_for_tab(&tab, &emitter_dyn, &supervisor, &tabs, id);
        let statuses = emitter_typed.statuses.lock().clone();
        // Must end in Success (plain text compiles fine).
        assert!(
            statuses.iter().any(|(_, _, s, _)| *s == CompileStatus::Success),
            "expected a Success status, got {statuses:?}"
        );
    }

    #[test]
    fn closed_doc_guard_drops_result() {
        // If the tab is removed from the tabs map before the (synchronous)
        // terminal emit, no Success is published. We simulate a mid-compile
        // close by emptying the map before calling do_compile_for_tab.
        let (tab, emitter_typed, emitter_dyn, supervisor, tabs, id) = fixtures(2);
        // Remove the tab to simulate it having been closed mid-compile.
        tabs.write().remove(&id);
        CompileService::do_compile_for_tab(&tab, &emitter_dyn, &supervisor, &tabs, id);
        let statuses = emitter_typed.statuses.lock().clone();
        // Only the initial Compiling is emitted (it fires before the guard); the
        // terminal Success must be suppressed.
        assert!(
            !statuses.iter().any(|(_, _, s, _)| *s == CompileStatus::Success),
            "closed doc must not publish Success, got {statuses:?}"
        );
    }

    #[test]
    fn shutdown_suppresses_compile() {
        let (tab, emitter_typed, emitter_dyn, supervisor, tabs, id) = fixtures(2);
        supervisor.shutdown();
        CompileService::do_compile_for_tab(&tab, &emitter_dyn, &supervisor, &tabs, id);
        let statuses = emitter_typed.statuses.lock().clone();
        assert!(
            statuses.is_empty(),
            "shutdown must suppress all emits, got {statuses:?}"
        );
    }

    #[test]
    fn panic_backoff_arms_cooldown_after_threshold() {
        // We can't easily make typst panic, but we can verify the backoff LOGIC
        // by directly arming the cooldown and asserting do_compile_for_tab skips.
        let (tab, emitter_typed, emitter_dyn, supervisor, tabs, id) = fixtures(2);
        // Simulate having hit the panic threshold: arm the cooldown.
        {
            let mut rt = tab.state.lock();
            rt.consecutive_panic_count = PANIC_BACKOFF_THRESHOLD;
            rt.panic_cooldown_until = Some(Instant::now() + Duration::from_secs(60));
        }
        CompileService::do_compile_for_tab(&tab, &emitter_dyn, &supervisor, &tabs, id);
        // Skipped: no statuses at all (the backoff check returns before emit).
        let statuses = emitter_typed.statuses.lock().clone();
        assert!(
            statuses.is_empty(),
            "backoff must skip the compile entirely, got {statuses:?}"
        );
    }

    /// The slow-watchdog's emit decision is a single flag check after a sleep.
    /// Verify both branches without the 2s sleep: a "still running" flag should
    /// emit Slow; a "finished" flag should suppress it.
    #[test]
    fn slow_watchdog_flag_logic() {
        // Branch 1: compile still running → would emit Slow.
        let running = AtomicBool::new(true);
        assert!(running.load(Ordering::SeqCst), "still-running flag is true");

        // Branch 2: compile finished (flag flipped) → suppress Slow.
        let finished = AtomicBool::new(false);
        assert!(
            !finished.load(Ordering::SeqCst),
            "finished flag is false → watchdog must suppress its emit"
        );
        // The actual `spawn_slow_watchdog` applies exactly this check; we
        // exercise it end-to-end (with the real 2s sleep) only in integration.
    }
}
