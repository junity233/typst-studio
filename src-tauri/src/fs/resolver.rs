//! `FileResolver` — maps typst [`FileId`] virtual paths to real disk paths and
//! reads them. Handles BOTH kinds of virtual root:
//!
//! - **`VirtualRoot::Project`** — files under the workspace root. Resolved
//!   against the (mutable) project root via [`VirtualPath::realize`]. This is
//!   what makes `#include` / `#read` / `#image()` work relative to the open
//!   workspace.
//! - **`VirtualRoot::Package(spec)`** — files inside an external package
//!   (`@preview/...`, `@local/...`). Resolved via the process-wide
//!   [`SystemPackages`](typst_kit::packages::SystemPackages) to the package
//!   cache directory, downloading on first use. Without this branch, typst
//!   would wrongly read the project directory's files for a package FileId,
//!   producing spurious `package manifest contains mismatched name` errors
//!   when the workspace itself happens to be a package.
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
use typst::syntax::{FileId, Source, VirtualPath, VirtualRoot};
use typst_kit::packages::SystemPackages;

/// Resolves typst [`FileId`]s to disk paths and reads their contents. Handles
/// both project-rooted files and package-rooted files. Cheap to clone (the root
/// is behind an `Arc`, the [`SystemPackages`] handle is a shared `Arc`).
///
/// The project root is mutable behind a [`RwLock`] so it can be swapped when the
/// user opens a different folder without rebuilding the world's resolver
/// reference. The package source (cache + data dirs + registry) is process-wide
/// and immutable.
#[derive(Clone)]
pub struct FileResolver {
    root: Arc<RwLock<PathBuf>>,
    packages: Arc<SystemPackages>,
}

impl FileResolver {
    /// Create a resolver anchored at `root`, using the process-wide package
    /// source for `VirtualRoot::Package` FileIds.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(RwLock::new(root)),
            packages: crate::fs::packages::system_packages(),
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
    /// escapes the root. Only Project-rooted ids are produced here — package ids
    /// are interned by typst's package resolver (`import.rs`) internally.
    pub fn file_id_for(&self, disk_path: &Path) -> FileResult<FileId> {
        use typst::syntax::RootedPath;
        let root = self.root.read().clone();
        // `VirtualizeError` has no `Into<FileError>` impl, so map by hand.
        let vpath = VirtualPath::virtualize(&root, disk_path)
            .map_err(|e| FileError::Other(Some(e.to_string().into())))?;
        Ok(FileId::new(RootedPath::new(VirtualRoot::Project, vpath)))
    }

    /// Convert a [`FileId`] to its disk path. For a Project root this realizes
    /// the vpath under the workspace root; for a Package root this resolves to
    /// the package's directory in the cache/data dir.
    fn disk_path(&self, id: FileId) -> FileResult<PathBuf> {
        match id.get().root() {
            VirtualRoot::Project => {
                let root = self.root.read().clone();
                Ok(id.vpath().realize(&root)?)
            }
            VirtualRoot::Package(spec) => {
                // Obtain the package's FsRoot (may download on a cache miss),
                // then resolve the vpath within it. A package error (not found,
                // malformed archive) surfaces as a FileError::Other so the
                // compile reports it as a diagnostic.
                let root = self
                    .packages
                    .obtain(spec)
                    .map_err(|e| FileError::Other(Some(e.to_string().into())))?;
                root.resolve(id.vpath())
            }
        }
    }

    /// Public [`disk_path`](Self.disk_path) for consumers that need the disk
    /// path of a non-main id without reading the file (e.g. the in-memory VFS
    /// overlay in [`EditorWorld`](crate::typst_engine::world::EditorWorld) keys
    /// its lookups by canonical disk path). Returns the same path
    /// [`read_source`](Self.read_source) / [`read_bytes`](Self.read_bytes)
    /// would read. Note: package-rooted ids return their real cache path here,
    /// but the VFS overlay never holds package files (see `EditorWorld`).
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
        // For package-rooted files, delegate to SystemPackages' FsRoot which
        // enforces no-escape and reads bytes in one call (avoids a redundant
        // disk_path + read pair, and keeps package I/O consistent with how
        // typst-kit itself loads package files).
        if let VirtualRoot::Package(spec) = id.get().root() {
            let root = self
                .packages
                .obtain(spec)
                .map_err(|e| FileError::Other(Some(e.to_string().into())))?;
            return root.load(id.vpath());
        }
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

    /// A package-rooted FileId must NOT be read from the project root — it must
    /// go through SystemPackages (cache/data dirs). This is the regression test
    /// for the `package manifest contains mismatched name` bug: before the
    /// `id.root()` dispatch, a package's `typst.toml` was wrongly realized under
    /// the workspace root. We assert that a package-rooted id for a
    /// nonexistent package errors (package-not-found), NOT that it reads a
    /// same-named file under the project root.
    #[test]
    fn package_rooted_id_does_not_read_from_project_root() {
        let (r, root) = tmp_workspace();
        // Plant a decoy `typst.toml` at the project root — the OLD bug would
        // have read this for any package FileId. The dispatch fix must NOT.
        fs::write(
            root.join("typst.toml"),
            "[package]\nname = \"decoy\"\nversion = \"0.0.0\"\n",
        )
        .unwrap();

        // A PackageSpec that is (almost certainly) NOT installed in the test
        // environment's package cache. Use an absurd version to guarantee a miss.
        let spec: typst::syntax::package::PackageSpec =
            "@preview/this-package-does-not-exist-zzz:9999.9999.9999"
                .parse()
                .expect("valid spec");
        let id = FileId::new(RootedPath::new(
            VirtualRoot::Package(spec),
            VirtualPath::new("typst.toml").unwrap(),
        ));

        // read_bytes must error (package not found / download failed) — it must
        // NOT succeed by reading the project-root decoy.
        let res = r.read_bytes(id);
        assert!(
            res.is_err(),
            "package-rooted id must not read from project root; got {:?}",
            res
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// A project-rooted FileId continues to resolve against the workspace root
    /// (the pre-package behavior is unchanged). Guards against the dispatch
    /// accidentally rerouting project files into the package handler.
    #[test]
    fn project_rooted_id_still_reads_from_project_root() {
        let (r, root) = tmp_workspace();
        let id = id_for(&r, "main.typ");
        let src = r.read_source(id).unwrap();
        assert_eq!(src.text(), "main");
        let _ = fs::remove_dir_all(&root);
    }
}
