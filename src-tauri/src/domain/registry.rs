//! `DocumentRegistry` — the canonical-path → `DocumentId` index (§4.1).
//!
//! Enforces the document-identity invariant: at most one open document per
//! canonical path. The [`EditorService`](crate::service::editor_service::EditorService)
//! consults this before creating a new tab so that opening the same file from
//! the dialog, the file tree, or session restore yields a single document.
//!
//! The registry is intentionally lightweight: it stores [`DocumentMeta`]
//! snapshots (id + origin) keyed by both id and canonical path. It does not own
//! the [`EditorWorld`](crate::typst_engine::world::EditorWorld) or compile
//! state — those remain in `EditorService`. The registry is the identity
//! authority; the service is the content authority.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::domain::document::{DocumentId, DocumentMeta};
use crate::error::{AppError, Result};

/// Index of open documents by id and by canonical path.
///
/// Both maps are kept in sync: inserting/removing/rebinding updates both. The
/// canonical-path map enforces the uniqueness invariant (§4.1).
#[derive(Debug, Default)]
pub struct DocumentRegistry {
    /// `DocumentId → DocumentMeta` snapshot (id, path, title, dirty, origin).
    by_id: HashMap<DocumentId, DocumentMeta>,
    /// Canonical path → `DocumentId`. Absent for [`DocumentOrigin::Untitled`].
    by_canonical: HashMap<PathBuf, DocumentId>,
}

impl DocumentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of open documents (including untitled).
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// Register a document. Errors with [`AppError::AlreadyOpen`] if the
    /// document's canonical path is already bound to a **different** id
    /// (§4.1). Re-registering the same id with the same path is idempotent.
    pub fn register(&mut self, meta: DocumentMeta) -> Result<()> {
        if let Some(canon) = meta.origin.canonical_path() {
            let canon = canon.to_path_buf();
            if let Some(&existing) = self.by_canonical.get(&canon) {
                if existing != meta.id {
                    return Err(AppError::AlreadyOpen {
                        existing_id: existing,
                        path: canon.to_string_lossy().to_string(),
                    });
                }
            }
            self.by_canonical.insert(canon, meta.id);
        }
        self.by_id.insert(meta.id, meta);
        Ok(())
    }

    /// Remove a document by id, also dropping its canonical-path entry.
    /// Returns the removed metadata, or `None` if not registered.
    pub fn unregister(&mut self, id: DocumentId) -> Option<DocumentMeta> {
        let removed = self.by_id.remove(&id)?;
        if let Some(canon) = removed.origin.canonical_path() {
            // Only remove the path entry if it still points at *this* id;
            // a rebind may have already moved it.
            if self.by_canonical.get(canon) == Some(&id) {
                self.by_canonical.remove(canon);
            }
        }
        Some(removed)
    }

    /// Replace a document's metadata in place, updating the canonical-path
    /// index if its path changed (e.g. Save As, workspace re-classification).
    ///
    /// Errors with [`AppError::AlreadyOpen`] if the new canonical path is
    /// already bound to a different id. Preserves the `DocumentId`.
    pub fn rebind(&mut self, id: DocumentId, new_meta: DocumentMeta) -> Result<()> {
        debug_assert_eq!(
            id, new_meta.id,
            "rebind must preserve the DocumentId"
        );
        let old = self.by_id.get(&id).cloned();
        // Reject path conflicts *before* mutating.
        if let Some(new_canon) = new_meta.origin.canonical_path() {
            if let Some(&holder) = self.by_canonical.get(new_canon) {
                if holder != id {
                    return Err(AppError::AlreadyOpen {
                        existing_id: holder,
                        path: new_canon.to_string_lossy().to_string(),
                    });
                }
            }
        }
        // Drop the old canonical entry if it differs from the new one.
        if let Some(old_meta) = &old {
            if let Some(old_canon) = old_meta.origin.canonical_path() {
                if Some(old_canon) != new_meta.origin.canonical_path() {
                    if self.by_canonical.get(old_canon) == Some(&id) {
                        self.by_canonical.remove(old_canon);
                    }
                }
            }
        }
        // Insert the new canonical entry.
        if let Some(new_canon) = new_meta.origin.canonical_path() {
            self.by_canonical.insert(new_canon.to_path_buf(), id);
        }
        self.by_id.insert(id, new_meta);
        Ok(())
    }

    /// Look up a document's id by canonical path, if any.
    pub fn find_by_canonical(&self, path: &std::path::Path) -> Option<DocumentId> {
        self.by_canonical.get(path).copied()
    }

    /// Metadata for an id, if registered.
    pub fn get(&self, id: DocumentId) -> Option<&DocumentMeta> {
        self.by_id.get(&id)
    }

    /// Snapshots of all registered documents.
    pub fn list(&self) -> Vec<DocumentMeta> {
        self.by_id.values().cloned().collect()
    }

    /// Mark a document as hidden (soft-closed) or visible (§B1). The flag is
    /// orthogonal to registration: a hidden document stays in `by_id` /
    /// `by_canonical` so [`find_by_canonical`](Self::find_by_canonical) still
    /// returns its id — that's the reuse anchor that lets reopening a soft-closed
    /// file reactivate instead of re-opening. No-op if `id` is not registered.
    pub fn set_hidden(&mut self, id: DocumentId, hidden: bool) {
        if let Some(meta) = self.by_id.get_mut(&id) {
            meta.hidden = hidden;
        }
    }
}

/// Concurrency wrapper — the registry is shared across the editor service and
/// consulted on open/close/rebind from multiple call sites. Wrap in `Arc` to
/// clone a handle into worker closures.
pub type SharedRegistry = Arc<RwLock<DocumentRegistry>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::document::WorkspaceId;

    fn ws_meta(id: DocumentId, path: &str) -> DocumentMeta {
        DocumentMeta::with_workspace_path(id, PathBuf::from(path), WorkspaceId::new())
    }

    #[test]
    fn register_and_lookup() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        let meta = ws_meta(id, "/tmp/a.typ");
        reg.register(meta.clone()).unwrap();
        assert_eq!(reg.get(id).map(|m| m.id), Some(id));
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/a.typ")), Some(id));
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn duplicate_canonical_path_rejected_but_returns_existing_id() {
        let mut reg = DocumentRegistry::new();
        let first = DocumentId::new();
        reg.register(ws_meta(first, "/tmp/dup.typ")).unwrap();
        let second = DocumentId::new();
        let err = reg.register(ws_meta(second, "/tmp/dup.typ")).unwrap_err();
        match err {
            AppError::AlreadyOpen { existing_id, .. } => assert_eq!(existing_id, first),
            other => panic!("expected AlreadyOpen, got {other:?}"),
        }
        // Registry unchanged: still one document, still the first id.
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/dup.typ")), Some(first));
    }

    #[test]
    fn re_register_same_id_same_path_is_idempotent() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        let meta = ws_meta(id, "/tmp/idem.typ");
        reg.register(meta.clone()).unwrap();
        // Same id, same path → no conflict.
        reg.register(meta).unwrap();
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn rebind_changes_canonical_index() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        reg.register(ws_meta(id, "/tmp/old.typ")).unwrap();
        let new_meta = ws_meta(id, "/tmp/new.typ");
        reg.rebind(id, new_meta).unwrap();
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/old.typ")), None);
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/new.typ")), Some(id));
        // Same document, just relocated.
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn rebind_to_conflicting_path_rejected() {
        let mut reg = DocumentRegistry::new();
        let a = DocumentId::new();
        let b = DocumentId::new();
        reg.register(ws_meta(a, "/tmp/a.typ")).unwrap();
        reg.register(ws_meta(b, "/tmp/b.typ")).unwrap();
        // Rebind b onto a's path → conflict.
        let err = reg.rebind(b, ws_meta(b, "/tmp/a.typ")).unwrap_err();
        assert!(matches!(err, AppError::AlreadyOpen { .. }));
        // Registry intact: both originals still resolvable.
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/a.typ")), Some(a));
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/b.typ")), Some(b));
    }

    #[test]
    fn unregister_releases_path_slot() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        reg.register(ws_meta(id, "/tmp/gone.typ")).unwrap();
        assert!(reg.unregister(id).is_some());
        assert!(reg.get(id).is_none());
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/gone.typ")), None);
        // After unregistering, the path is free again.
        let id2 = DocumentId::new();
        reg.register(ws_meta(id2, "/tmp/gone.typ")).unwrap();
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/gone.typ")), Some(id2));
    }

    #[test]
    fn untitled_documents_carry_no_canonical_path() {
        let mut reg = DocumentRegistry::new();
        let a = DocumentMeta::new_untitled();
        let b = DocumentMeta::new_untitled();
        // Two untitleds must coexist (no canonical path to collide on).
        reg.register(a.clone()).unwrap();
        reg.register(b.clone()).unwrap();
        assert_eq!(reg.len(), 2);
    }

    #[test]
    fn untitled_then_save_rebinds_to_canonical() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        let untitled = DocumentMeta {
            id,
            ..DocumentMeta::new_untitled()
        };
        reg.register(untitled).unwrap();
        // Save As to a real path.
        reg.rebind(id, ws_meta(id, "/tmp/saved.typ")).unwrap();
        assert_eq!(reg.find_by_canonical(std::path::Path::new("/tmp/saved.typ")), Some(id));
        assert_eq!(reg.len(), 1);
    }

    /// §B1: `set_hidden` flips the flag on the registered meta, and a hidden
    /// document stays resolvable by both id and canonical path (the reuse
    /// anchor for reactivate).
    #[test]
    fn set_hidden_flips_flag_and_keeps_doc_registered() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        reg.register(ws_meta(id, "/tmp/hide.typ")).unwrap();
        assert!(!reg.get(id).unwrap().hidden);

        reg.set_hidden(id, true);
        assert!(reg.get(id).unwrap().hidden, "hidden flag must be set");
        // Still resolvable by canonical path — the whole point of soft-close is
        // that find_existing returns the hidden id so the frontend reactivates
        // instead of opening a duplicate.
        assert_eq!(
            reg.find_by_canonical(std::path::Path::new("/tmp/hide.typ")),
            Some(id),
            "hidden docs must remain findable by canonical path"
        );
        assert_eq!(reg.len(), 1, "soft-close must NOT shrink the registry");

        // Toggling back to visible is symmetric.
        reg.set_hidden(id, false);
        assert!(!reg.get(id).unwrap().hidden);
    }

    /// `set_hidden` on an unknown id is a silent no-op (soft_close / reactivate
    /// guard on the tab map, which is the authority on "open at all").
    #[test]
    fn set_hidden_on_unknown_id_is_noop() {
        let mut reg = DocumentRegistry::new();
        reg.set_hidden(DocumentId::new(), true); // must not panic
        assert_eq!(reg.len(), 0);
    }
}
