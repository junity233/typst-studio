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
use crate::domain::document::{DocumentId, DocumentMeta};
use crate::typst_engine::world::EditorWorld;

/// Mutable-per-tab state that changes on compile / save / edit. Behind a Mutex
/// separate from the world so compile never blocks on it.
pub struct TabRuntime {
    /// Tab metadata (id, path, title, dirty).
    pub meta: DocumentMeta,
    /// The last successfully compiled document (for export). `None` until the
    /// first successful compile, or after a failing compile.
    pub last_doc: Option<PagedDocument>,
    /// The outcome of the last compile (success flag, duration, errors).
    pub last_outcome: CompileOutcome,
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
        let meta = DocumentMeta::from_path(std::path::PathBuf::from("/tmp/notes.typ"));
        let id = meta.id;
        let tab = TabState::with_meta(meta, "#hi".to_string());
        let rt = tab.state.lock();
        assert_eq!(rt.meta.id, id);
        assert_eq!(rt.meta.title, "notes");
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
