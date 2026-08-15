//! Shared scaffolding for the service unit-test suites.
//!
//! One recording [`Emitter`] implementation and one polling wait, replacing
//! the per-suite copies (CapturingEmitter / RecordingEmitter / SpyEmitter ×2 /
//! ConflictsEmitter / NoopEmitter) that had drifted on timeouts and
//! panic-on-timeout behavior. Timeout POLICY stays at each call site: the
//! suites deliberately differ (`panic!` vs silent return).

use crate::domain::compile_status::CompileStatus;
use crate::domain::diagnostics::Diagnostic;
use crate::domain::document::{ConflictState, DocumentId};
use crate::domain::outline::OutlineNode;
use crate::domain::source_map::LineRect;
use crate::service::editor_service::Emitter;
use parking_lot::Mutex;

/// An event captured by [`CapturingEmitter`], for assertion in tests.
///
/// The payload fields mirror the real wire format so a test asserting on
/// specifics (pages, diagnostics, status) has the data available. The
/// `revision` field is the document revision the result corresponds to (§7).
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub enum CapturedEvent {
    Compiled {
        id: DocumentId,
        revision: u64,
        page_count: usize,
        full: bool,
        changed_pages: Vec<crate::ipc::events::ChangedPage>,
        line_map: Vec<LineRect>,
        outline: Vec<OutlineNode>,
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

/// A recorded `emit_status` entry: (document, revision, status, duration_ms).
pub type StatusLog = (DocumentId, u64, CompileStatus, Option<u64>);

/// Records every emit into a vector so tests can assert on the event stream.
pub struct CapturingEmitter {
    events: Mutex<Vec<CapturedEvent>>,
}

impl CapturingEmitter {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
        }
    }

    /// Every captured event so far, in emit order.
    pub fn snapshot(&self) -> Vec<CapturedEvent> {
        self.events.lock().clone()
    }

    /// Drop all captured events (e.g. to isolate a later emit burst).
    pub fn clear(&self) {
        self.events.lock().clear();
    }

    /// All `emit_status` records as `(id, revision, status, duration_ms)`.
    pub fn statuses(&self) -> Vec<StatusLog> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Status { id, revision, status, duration_ms } => {
                    Some((id, revision, status, duration_ms))
                }
                _ => None,
            })
            .collect()
    }

    /// Statuses emitted for `id`, in emit order.
    pub fn statuses_for(&self, id: DocumentId) -> Vec<CompileStatus> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Status { id: eid, status, .. } if eid == id => Some(status),
                _ => None,
            })
            .collect()
    }

    /// Revisions of all `compiled` events for `id`, in emit order.
    pub fn compiled_revisions_for(&self, id: DocumentId) -> Vec<u64> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Compiled { id: eid, revision, .. } if eid == id => Some(revision),
                _ => None,
            })
            .collect()
    }

    /// Ids of every `compiled` event, in emit order.
    pub fn compiled_ids(&self) -> Vec<DocumentId> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Compiled { id, .. } => Some(id),
                _ => None,
            })
            .collect()
    }

    /// `(id, full)` per `compiled` event — drives the replay-as-full assertions.
    pub fn compiled_full(&self) -> Vec<(DocumentId, bool)> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Compiled { id, full, .. } => Some((id, full)),
                _ => None,
            })
            .collect()
    }

    /// `(page_count, full, changed_count)` per `compiled` event — drives the
    /// incremental-rendering assertions.
    pub fn compiled_summaries(&self) -> Vec<(usize, bool, usize)> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Compiled { page_count, full, changed_pages, .. } => {
                    Some((page_count, full, changed_pages.len()))
                }
                _ => None,
            })
            .collect()
    }

    /// All `emit_conflict` records as `(id, conflict)`, in emit order.
    pub fn conflicts(&self) -> Vec<(DocumentId, ConflictState)> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Conflict { id, conflict, .. } => Some((id, conflict)),
                _ => None,
            })
            .collect()
    }

    /// Conflict states emitted for `id`, in emit order.
    pub fn conflicts_for(&self, id: DocumentId) -> Vec<ConflictState> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Conflict { id: eid, conflict, .. } if eid == id => Some(conflict),
                _ => None,
            })
            .collect()
    }
}

impl Default for CapturingEmitter {
    fn default() -> Self {
        Self::new()
    }
}

impl Emitter for CapturingEmitter {
    fn emit_compiled(
        &self,
        id: DocumentId,
        revision: u64,
        page_count: usize,
        full: bool,
        changed_pages: Vec<crate::ipc::events::ChangedPage>,
        line_map: Vec<LineRect>,
        outline: Vec<OutlineNode>,
        duration_ms: u64,
    ) {
        self.events.lock().push(CapturedEvent::Compiled {
            id,
            revision,
            page_count,
            full,
            changed_pages,
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

/// An [`Emitter`] whose every method is a no-op — for suites that only need
/// the trait satisfied and never assert on events.
pub struct NoopEmitter;

impl Emitter for NoopEmitter {
    fn emit_compiled(
        &self,
        _: DocumentId,
        _: u64,
        _: usize,
        _: bool,
        _: Vec<crate::ipc::events::ChangedPage>,
        _: Vec<LineRect>,
        _: Vec<OutlineNode>,
        _: u64,
    ) {
    }
    fn emit_diagnostics(&self, _: DocumentId, _: u64, _: Vec<Diagnostic>) {}
    fn emit_status(&self, _: DocumentId, _: u64, _: CompileStatus, _: Option<u64>) {}
    fn emit_conflict(&self, _: DocumentId, _: u64, _: ConflictState, _: Option<String>) {}
}

/// Poll `cond` every 25 ms, up to `attempts` times. Returns whether it ever
/// held — the caller owns the timeout policy (`panic!` vs silent return).
pub fn wait_until(attempts: usize, cond: impl Fn() -> bool) -> bool {
    for _ in 0..attempts {
        if cond() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    false
}
