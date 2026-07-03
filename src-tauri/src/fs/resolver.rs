//! `FileResolver` — maps typst [`FileId`] virtual paths to real disk paths
//! under a workspace root, and reads them.
//!
//! This is what makes `#include` / `#read` / `#image()` work in
//! [`crate::typst_engine::EditorWorld`]. Typst resolves includes *relative to
//! the parent source's [`FileId`] vpath* and hands the resulting `FileId` to
//! `World::source` / `World::file`. We convert that vpath back to a disk path
//! with [`VirtualPath::realize`] and read it.
//!
//! When no workspace is open (an untitled tab), the world holds `None` resolver
//! and falls back to the MVP `NotFound` behavior — so single-file editing is
//! unchanged.
//!
//! All filesystem access is confined here so the world never imports `std::fs`.
//!
//! [`VirtualPath::realize`]: typst::syntax::VirtualPath::realize

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use typst::diag::{FileError, FileResult};
use typst::foundations::Bytes;
use typst::syntax::{FileId, Source, VirtualPath};

/// Resolves typst [`FileId`]s to disk paths under a workspace root and reads
/// their contents. Cheap to clone (the root is behind an `Arc`).
///
/// The root is mutable behind a [`RwLock`] so it can be swapped when the user
/// opens a different folder without rebuilding the world's resolver reference.
#[derive(Clone)]
pub struct FileResolver {
    root: Arc<RwLock<PathBuf>>,
}

impl FileResolver {
    /// Create a resolver anchored at `root`.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(RwLock::new(root)),
        }
    }

    /// The current workspace root.
    pub fn root(&self) -> PathBuf {
        self.root.read().clone()
    }

    /// Replace the workspace root (used when switching workspaces).
    pub fn set_root(&self, root: PathBuf) {
        *self.root.write() = root;
    }

    /// Convert a disk path (which must be under the workspace root) into a typst
    /// [`FileId`] anchored at the project virtual root. Errors if the path
    /// escapes the root.
    pub fn file_id_for(&self, disk_path: &Path) -> FileResult<FileId> {
        use typst::syntax::{RootedPath, VirtualRoot};
        let root = self.root.read().clone();
        // `VirtualizeError` has no `Into<FileError>` impl, so map by hand.
        let vpath = VirtualPath::virtualize(&root, disk_path)
            .map_err(|e| FileError::Other(Some(e.to_string().into())))?;
        Ok(FileId::new(RootedPath::new(VirtualRoot::Project, vpath)))
    }

    /// Convert a [`FileId`] to its disk path under the workspace root.
    /// `RealizeError` converts to `FileError::Realize` via `From`.
    fn disk_path(&self, id: FileId) -> FileResult<PathBuf> {
        let root = self.root.read().clone();
        Ok(id.vpath().realize(&root)?)
    }

    /// Public [`disk_path`](Self::disk_path) for consumers that need the disk
    /// path of a non-main id without reading the file (e.g. the in-memory VFS
    /// overlay in [`EditorWorld`](crate::typst_engine::world::EditorWorld) keys
    /// its lookups by canonical disk path). Returns the same path
    /// [`read_source`](Self::read_source) / [`read_bytes`](Self::read_bytes)
    /// would read.
    pub fn disk_path_of(&self, id: FileId) -> FileResult<PathBuf> {
        self.disk_path(id)
    }

    /// Read + parse a `.typ` source for `World::source(id)`. Returns a
    /// [`Source`] whose id matches `id` (built via `Source::new`, *not*
    /// `Source::detached`, so include resolution off it is correct).
    pub fn read_source(&self, id: FileId) -> FileResult<Source> {
        let path = self.disk_path(id)?;
        let text = std::fs::read_to_string(&path).map_err(|e| FileError::from_io(e, &path))?;
        Ok(Source::new(id, text))
    }

    /// Read raw bytes for `World::file(id)`. Works for both source files (the
    /// raw text) and binary assets (images, etc.). Some typst internals call
    /// `file` even for source ids, so this must not refuse them.
    pub fn read_bytes(&self, id: FileId) -> FileResult<Bytes> {
        let path = self.disk_path(id)?;
        let data = std::fs::read(&path).map_err(|e| FileError::from_io(e, &path))?;
        Ok(Bytes::new(data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use typst::syntax::{RootedPath, VirtualRoot};

    /// Build a resolver over a temp workspace with a couple of files and a
    /// subdirectory, returning `(resolver, root)`.
    fn tmp_workspace() -> (FileResolver, PathBuf) {
        let root = std::env::temp_dir().join(format!("typst-fs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("main.typ"), "main").unwrap();
        fs::write(root.join("sub").join("intro.typ"), "intro").unwrap();
        fs::write(root.join("img.png"), b"PNG").unwrap();
        let r = FileResolver::new(root.clone());
        (r, root)
    }

    fn id_for(resolver: &FileResolver, rel: &str) -> FileId {
        let root = resolver.root();
        let disk = root.join(rel);
        resolver.file_id_for(&disk).unwrap()
    }

    #[test]
    fn disk_path_round_trips_through_realize() {
        let (r, root) = tmp_workspace();
        let id = id_for(&r, "sub/intro.typ");
        // read_source returns a Source with the SAME id.
        let src = r.read_source(id).unwrap();
        assert_eq!(src.id(), id, "Source must carry the requested FileId");
        assert_eq!(src.text(), "intro");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_bytes_returns_file_contents() {
        let (r, root) = tmp_workspace();
        let id = id_for(&r, "img.png");
        let bytes = r.read_bytes(id).unwrap();
        assert_eq!(bytes.as_ref(), b"PNG");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn file_id_is_stable_for_same_path() {
        let (r, root) = tmp_workspace();
        // FileId interns identical RootedPaths — same path → same id.
        let a = id_for(&r, "main.typ");
        let b = id_for(&r, "main.typ");
        assert_eq!(a, b);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_outside_root_is_rejected() {
        let (r, root) = tmp_workspace();
        let outside = std::env::temp_dir().join("typst-fs-elsewhere.typ");
        fs::write(&outside, "x").unwrap();
        let res = r.file_id_for(&outside);
        assert!(res.is_err(), "paths outside the root must not resolve");
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_root_swaps_workspace() {
        let (r, root) = tmp_workspace();
        let new_root = std::env::temp_dir().join(format!("typst-fs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        fs::write(new_root.join("other.typ"), "other").unwrap();
        r.set_root(new_root.clone());
        assert_eq!(r.root(), new_root);
        let id = id_for(&r, "other.typ");
        let src = r.read_source(id).unwrap();
        assert_eq!(src.text(), "other");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn resolver_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<FileResolver>();
        // Sanity: RootedPath/VirtualRoot are usable from here.
        let _ = RootedPath::new(VirtualRoot::Project, VirtualPath::new("x.typ").unwrap());
    }
}
