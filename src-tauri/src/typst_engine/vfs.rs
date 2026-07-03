//! `MemoryVfs` — in-memory overlay of open documents' buffers (§5 end).
//!
//! When a document is open in the editor, its possibly-unsaved buffer is the
//! source of truth, not whatever is on disk. The compiler, however, resolves
//! `#include` / `#read` / `#image()` by asking the [`World`] for a non-main
//! [`FileId`], and the world's default answer for a non-main file is "read it
//! from disk". That means unsaved edits to an *included* file were invisible to
//! the including document's compile until the user saved — a confusing
//! disconnect (§15.2 integration test 3).
//!
//! `MemoryVfs` closes that gap. [`EditorService`](crate::service::EditorService)
//! owns a single shared `MemoryVfs` and keeps it in sync with every open
//! document's live buffer (keyed by canonical disk path). Each tab's
//! [`EditorWorld`](super::world::EditorWorld) consults this VFS *before*
//! falling back to disk: if the requested file is an open document, the live
//! buffer wins.
//!
//! ## Keying
//!
//! Entries are keyed by **canonical disk path** — the same key the
//! [`FileResolver`](crate::fs::FileResolver) produces when it converts a
//! [`FileId`] back to a disk path via [`realize`](typst::syntax::VirtualPath).
//! That keeps the lookup consistent regardless of which resolver scope
//! (workspace root vs. loose-file parent dir) produced the id.
//!
//! ## Scope
//!
//! Only text buffers live here. The VFS is consulted first in
//! [`World::source`](typst::World::source) and
//! [`World::file`](typst::World::file); on a miss the world reads disk as
//! before. Binary assets (`#image(...)`) always miss (we never insert them), so
//! they transparently fall through to the disk read — no special-casing needed.
//!
//! The *main* document's own buffer is already served from memory by
//! `EditorWorld::source` (the `id == source_id` branch), so the main document
//! is deliberately NOT inserted into the VFS — only *other* open documents
//! that might be `#include`d.
//!
//! [`FileId`]: typst::syntax::FileId
//! [`World`]: typst::World

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;

/// In-memory overlay of open documents' buffers, keyed by canonical disk path.
///
/// See the [module docs](self) for the full rationale. Cheap to clone behind an
/// `Arc` (the whole map is shared); [`EditorService`](crate::service::EditorService)
/// holds one `Arc<MemoryVfs>` and hands clones to every tab's
/// [`EditorWorld`](super::world::EditorWorld).
#[derive(Default)]
pub struct MemoryVfs {
    buffers: RwLock<std::collections::HashMap<PathBuf, Arc<VfsEntry>>>,
}

/// One buffer entry in the [`MemoryVfs`]: the live text + the document revision
/// it corresponds to. The revision is recorded for observability/debugging; the
/// world serves whatever text is present (the latest upsert always wins).
pub struct VfsEntry {
    /// The live (possibly unsaved) source text for this path.
    pub text: String,
    /// The [`DocumentMeta::revision`](crate::domain::document::DocumentMeta) this
    /// buffer was last synced from. Stored for diagnostics; not used to gate
    /// lookups.
    pub revision: u64,
}

impl MemoryVfs {
    /// Create an empty VFS.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace the buffer for `canonical_path`. Called by
    /// [`EditorService`](crate::service::EditorService) whenever an open
    /// document's text changes (open, edit, reload) so the compiler sees the
    /// latest buffer.
    pub fn upsert(&self, canonical_path: PathBuf, text: String, revision: u64) {
        self.buffers
            .write()
            .insert(canonical_path, Arc::new(VfsEntry { text, revision }));
    }

    /// Remove the buffer for `canonical_path` (e.g. when its document closes).
    /// No-op if the path isn't tracked.
    pub fn remove(&self, canonical_path: &Path) {
        self.buffers.write().remove(canonical_path);
    }

    /// Look up the live buffer for `canonical_path`. Returns `None` when the
    /// file is not an open document — in which case the caller reads disk.
    pub fn get(&self, canonical_path: &Path) -> Option<Arc<VfsEntry>> {
        self.buffers.read().get(canonical_path).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn upsert_then_get_returns_latest_entry() {
        let vfs = MemoryVfs::new();
        let path = PathBuf::from("/tmp/main.typ");
        assert!(vfs.get(&path).is_none());

        vfs.upsert(path.clone(), "v0".to_string(), 0);
        let entry = vfs.get(&path).expect("present after upsert");
        assert_eq!(entry.text, "v0");
        assert_eq!(entry.revision, 0);

        // A second upsert replaces the entry (latest wins).
        vfs.upsert(path.clone(), "v1".to_string(), 1);
        let entry = vfs.get(&path).expect("present after second upsert");
        assert_eq!(entry.text, "v1");
        assert_eq!(entry.revision, 1);
    }

    #[test]
    fn remove_drops_entry() {
        let vfs = MemoryVfs::new();
        let path = PathBuf::from("/tmp/intro.typ");
        vfs.upsert(path.clone(), "x".to_string(), 0);
        assert!(vfs.get(&path).is_some());

        vfs.remove(&path);
        assert!(vfs.get(&path).is_none(), "entry must be gone after remove");

        // Removing a missing key is a no-op (no panic).
        vfs.remove(&path);
    }

    #[test]
    fn get_returns_none_for_untracked_path() {
        let vfs = MemoryVfs::new();
        vfs.upsert(PathBuf::from("/tmp/a.typ"), "a".to_string(), 0);
        assert!(vfs.get(&PathBuf::from("/tmp/b.typ")).is_none());
        assert!(vfs.get(&PathBuf::from("/tmp/a.typ")).is_some());
    }

    #[test]
    fn get_clone_is_independent_of_subsequent_upsert() {
        // A previously-cloned entry must not change when a new upsert happens:
        // `Arc<VfsEntry>` is never mutated in place, only swapped wholesale.
        let vfs = MemoryVfs::new();
        let path = PathBuf::from("/tmp/main.typ");
        vfs.upsert(path.clone(), "first".to_string(), 0);
        let snapshot = vfs.get(&path).unwrap();
        vfs.upsert(path.clone(), "second".to_string(), 1);
        // The snapshot still sees the old text...
        assert_eq!(snapshot.text, "first");
        // ...while a fresh lookup sees the new one.
        assert_eq!(vfs.get(&path).unwrap().text, "second");
    }

    #[test]
    fn concurrent_upsert_and_get_are_safe() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::thread;
        let vfs = Arc::new(MemoryVfs::new());
        let path = PathBuf::from("/tmp/concurrent.typ");

        // Writer: many upserts from many threads.
        let writers: Vec<_> = (0..4)
            .map(|i| {
                let vfs = vfs.clone();
                let path = path.clone();
                thread::spawn(move || {
                    for n in 0..200 {
                        vfs.upsert(path.clone(), format!("t{i}-n{n}"), n);
                    }
                })
            })
            .collect();
        // Reader: repeated gets while writers run.
        let vfs_r = vfs.clone();
        let path_r = path.clone();
        let reader = thread::spawn(move || {
            let hits = AtomicUsize::new(0);
            for _ in 0..1000 {
                if vfs_r.get(&path_r).is_some() {
                    hits.fetch_add(1, Ordering::Relaxed);
                }
            }
            hits.into_inner()
        });
        for w in writers {
            w.join().expect("writer panicked");
        }
        let hits = reader.join().expect("reader panicked");
        // After all writers finish the entry is present.
        assert!(vfs.get(&path).is_some());
        // The reader observed at least some hits (the entry was upserted
        // immediately, so nearly all reads should hit).
        assert!(hits > 0, "reader should have observed the entry");
    }

    #[test]
    fn memory_vfs_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<MemoryVfs>();
        assert_send_sync::<Arc<MemoryVfs>>();
        assert_send_sync::<VfsEntry>();
        assert_send_sync::<Arc<VfsEntry>>();
    }
}
