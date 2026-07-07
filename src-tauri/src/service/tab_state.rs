//! `TabState` — per-tab world + metadata + last compile result.
//!
//! ## Lock design
//!
//! The `world` is NOT behind a Mutex: [`EditorWorld`] has its own interior
//! `RwLock<Source>`, and `typst::compile` takes `&dyn World` (immutable).
//! This means [`do_compile`](super::editor_service::EditorService::do_compile)
//! can compile and render a tab **without holding any tab-level lock** — the
//! ~5-200ms of CPU work is completely lock-free. Only the brief result store
//! at the end takes a Mutex.
//!
//! Metadata + last results live behind a separate [`Mutex`]`<`[`TabRuntime`]`>`
//! so they can be updated atomically without touching the world.

use parking_lot::Mutex;
use typst_layout::PagedDocument;

use crate::domain::compile_result::CompileOutcome;
use crate::domain::disk_version::{DiskVersion, FileIdentity};
use crate::domain::document::{ConflictState, DocumentId, DocumentMeta, DocumentOrigin};
use crate::typst_engine::world::EditorWorld;

/// Mutable-per-tab state that changes on compile / save / edit. Behind a Mutex
/// separate from the world so compile never blocks on it.
pub struct TabRuntime {
    /// Tab metadata (id, path, title, dirty, origin, revision, conflict).
    pub meta: DocumentMeta,
    /// The last successfully compiled document (for export). `None` until the
    /// first successful compile, or after a failing compile.
    pub last_doc: Option<PagedDocument>,
    /// The outcome of the last compile (success flag, duration, errors).
    pub last_outcome: CompileOutcome,
    /// The revision this `last_outcome` / `last_doc` corresponds to. `None`
    /// until the first compile completes. Used to discard stale results.
    pub last_compiled_revision: Option<u64>,
    /// On-disk content identity (§8.4). `None` for untitled / never-read-from-
    /// disk documents. Set when a file is opened, refreshed on every save
    /// (so the imminent watcher event is recognized as self-induced), and used
    /// by `handle_external_change` to distinguish an external edit from a
    /// touch-only change.
    pub disk_version: Option<DiskVersion>,
    /// On-disk file identity (inode) captured alongside `disk_version` (§5.4).
    /// Used to detect the `Replaced` conflict: an external tool rewrote the file
    /// with the SAME bytes (so `disk_version` equality holds) but a NEW inode.
    /// [`FileIdentity::UNKNOWN`] for untitled docs or platforms without a stable
    /// inode — the `Replaced` check then degrades to "never fire" safely.
    pub file_identity: FileIdentity,
    /// Consecutive compiler-panic count for this document (§6.2 backoff). Reset
    /// to 0 on any successful compile. When it reaches
    /// [`PANIC_BACKOFF_THRESHOLD`] the supervisor enters a cooling-off period
    /// during which recompile signals are skipped, so a pathological doc can't
    /// spin the worker. Tracked here (per-tab) rather than on the supervisor
    /// because it's a per-document property.
    ///
    /// [`PANIC_BACKOFF_THRESHOLD`]: super::compile_supervisor::PANIC_BACKOFF_THRESHOLD
    pub consecutive_panic_count: u32,
    /// Instant after which the worker may retry a panicking document (§6.2
    /// backoff). `None` when not in backoff. Stored as an `Instant`-equivalent
    /// epoch millis to avoid an `Instant` field (which isn't `Debug`-friendly in
    /// all contexts); the supervisor compares against `Instant::now()`. Set
    /// when `consecutive_panic_count` first hits the threshold; cleared on a
    /// successful compile.
    pub panic_cooldown_until: Option<std::time::Instant>,
}

/// Per-tab state: the editor world (lock-free during compile) + locked runtime.
pub struct TabState {
    /// The long-lived typst world for this tab. Reused across edits via its
    /// own interior `RwLock<Source>` — no tab-level lock needed to compile.
    pub world: EditorWorld,
    /// Metadata + last results, updated briefly after compile / save / edit.
    pub state: Mutex<TabRuntime>,
}

impl TabState {
    /// Create a new untitled tab with the given id and initial text.
    pub fn new(id: DocumentId, initial_text: String) -> Self {
        let meta = DocumentMeta {
            id,
            path: None,
            title: "Untitled".to_string(),
            dirty: false,
            origin: DocumentOrigin::Untitled,
            revision: 0,
            conflict: ConflictState::None,
            kind: crate::domain::document::DocumentKind::Typst,
            hidden: false,
        };
        Self::with_meta(meta, initial_text)
    }

    /// Create a tab from explicit metadata (e.g. an opened file) + initial text.
    pub fn with_meta(meta: DocumentMeta, initial_text: String) -> Self {
        Self {
            world: EditorWorld::new(initial_text),
            state: Mutex::new(TabRuntime {
                meta,
                last_doc: None,
                last_outcome: CompileOutcome::ok(0),
                last_compiled_revision: None,
                disk_version: None,
                file_identity: FileIdentity::UNKNOWN,
                consecutive_panic_count: 0,
                panic_cooldown_until: None,
            }),
        }
    }

    /// Create a tab from explicit metadata + a pre-built world. Used when the
    /// world must be workspace-backed (a [`FileResolver`] for `#include`), since
    /// [`with_meta`](Self::with_meta) always builds a detached single-file world.
    pub fn with_meta_and_world(meta: DocumentMeta, world: EditorWorld) -> Self {
        Self {
            world,
            state: Mutex::new(TabRuntime {
                meta,
                last_doc: None,
                last_outcome: CompileOutcome::ok(0),
                last_compiled_revision: None,
                disk_version: None,
                file_identity: FileIdentity::UNKNOWN,
                consecutive_panic_count: 0,
                panic_cooldown_until: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_untitled_tab() {
        let id = DocumentId::new();
        let tab = TabState::new(id, "Hello".to_string());
        let rt = tab.state.lock();
        assert_eq!(rt.meta.id, id);
        assert!(rt.meta.path.is_none());
        assert_eq!(rt.meta.title, "Untitled");
        assert!(!rt.meta.dirty);
        assert!(rt.last_doc.is_none());
        assert!(rt.last_outcome.success);
        assert_eq!(tab.world.text(), "Hello");
    }

    #[test]
    fn with_meta_carries_path_and_title() {
        let id = DocumentId::new();
        let meta = DocumentMeta::with_loose_path(
            id,
            std::path::PathBuf::from("/tmp/notes.typ"),
            std::path::PathBuf::from("/tmp"),
        );
        let tab = TabState::with_meta(meta, "#hi".to_string());
        let rt = tab.state.lock();
        assert_eq!(rt.meta.id, id);
        assert_eq!(rt.meta.title, "notes.typ");
        assert!(rt.meta.path.is_some());
        assert_eq!(tab.world.text(), "#hi");
    }

    #[test]
    fn world_is_accessible_without_state_lock() {
        // Verify the lock separation: we can read world.text() without locking
        // the Mutex (no deadlock risk between compile and metadata access).
        let tab = TabState::new(DocumentId::new(), "hello world".into());
        // This would deadlock if world were inside the Mutex.
        let _text = tab.world.text();
        let _meta = { tab.state.lock().meta.clone() };
        // Both succeeded without deadlock.
    }
}
