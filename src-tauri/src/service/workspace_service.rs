//! `WorkspaceService` — owns the open workspace (a single folder), its file
//! tree, file CRUD, and the filesystem watcher.
//!
//! "A workspace is a folder." Opening one anchors a [`FileResolver`] so that
//! tabs opened from the tree compile with `#include` / `#image()` resolution
//! against the workspace root. The service also applies file operations
//! (create / rename / delete / move) and surfaces external changes via a
//! `fs_changed` Tauri event (the watcher fires; the IPC layer emits).
//!
//! The service is workspace-scoped: it knows nothing about open tabs except
//! that the editor service borrows its resolver when opening a file. Tab
//! lifecycle (close-on-delete, path-update-on-rename) is coordinated by the IPC
//! command layer, which has both services.

use std::path::{Path, PathBuf};

use parking_lot::RwLock;

use crate::error::{AppError, Result};
use crate::fs::resolver::FileResolver;
use crate::fs::tree::{read_dir as fs_read_dir, DirEntry, EntryKind};
use crate::fs::watcher;

/// The currently open workspace, if any.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct WorkspaceMeta {
    /// Absolute path to the workspace root.
    pub root: String,
    /// Display name (the root folder's basename).
    pub name: String,
}

/// The workspace orchestration service.
pub struct WorkspaceService {
    /// The current workspace root, or `None` when no folder is open.
    root: RwLock<Option<PathBuf>>,
    /// A resolver over the current root, cheaply cloneable. `None` when closed.
    /// Cloned out by the editor service when opening a workspace-backed tab.
    resolver: RwLock<Option<FileResolver>>,
    /// Keeps the filesystem watcher alive while a workspace is open.
    watcher: RwLock<Option<watcher::WatcherGuard>>,
}

impl WorkspaceService {
    pub fn new() -> Self {
        Self {
            root: RwLock::new(None),
            resolver: RwLock::new(None),
            watcher: RwLock::new(None),
        }
    }

    /// Whether a workspace is currently open.
    pub fn is_open(&self) -> bool {
        self.root.read().is_some()
    }

    /// The current workspace root, if open.
    pub fn root(&self) -> Option<PathBuf> {
        self.root.read().clone()
    }

    /// A clone of the current resolver, if a workspace is open. The editor
    /// service calls this when opening a file from the tree so the tab compiles
    /// with `#include` resolution.
    pub fn resolver(&self) -> Option<FileResolver> {
        self.resolver.read().clone()
    }

    /// Open `root` as the workspace, replacing any prior workspace. Starts a
    /// filesystem watcher; `on_fs_change` is called (on the watcher thread) with
    /// changed paths so the IPC layer can emit a `fs_changed` event.
    pub fn open(&self, root: PathBuf, on_fs_change: watcher::OnChange) -> Result<WorkspaceMeta> {
        if !root.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "{} is not a directory",
                root.display()
            )));
        }
        let canonical = root.canonicalize().map_err(|e| AppError::Io(e))?;
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| canonical.display().to_string());

        // Swap root + resolver.
        *self.root.write() = Some(canonical.clone());
        let resolver = FileResolver::new(canonical.clone());
        *self.resolver.write() = Some(resolver);

        // (Re)start the watcher. Dropping the old guard stops it.
        match watcher::watch(&canonical, on_fs_change) {
            Ok(guard) => *self.watcher.write() = Some(guard),
            // A watcher failure is non-fatal — the workspace still works, just
            // without live external-change updates. Log and continue.
            Err(e) => tracing::warn!("could not start workspace watcher: {e}"),
        }

        Ok(WorkspaceMeta {
            root: canonical.display().to_string(),
            name,
        })
    }

    /// Close the workspace (stops the watcher, drops the resolver). Open tabs
    /// keep their already-compiled worlds; the editor service decides what to do
    /// with them.
    pub fn close(&self) {
        *self.watcher.write() = None;
        *self.resolver.write() = None;
        *self.root.write() = None;
    }

    /// Resolve a workspace-relative path string ("" or "." = root) to an
    /// absolute path under the current root. Errors if no workspace is open or
    /// the path escapes the root. Public entry point for commands (e.g.
    /// `reveal_in_finder`) that need the absolute path but do no other IO.
    pub fn resolve_path(&self, rel: &str) -> Result<PathBuf> {
        self.resolve_rel(rel)
    }

    /// Resolve a workspace-relative path string ("" or "." = root) to an
    /// absolute path under the current root. Errors if no workspace is open or
    /// the path escapes the root.
    fn resolve_rel(&self, rel: &str) -> Result<PathBuf> {
        let root = self
            .root
            .read()
            .clone()
            .ok_or_else(|| AppError::InvalidInput("no workspace open".into()))?;
        if rel.is_empty() || rel == "." {
            return Ok(root);
        }
        // Lexically normalize the joined path (resolving `..`/`.` without hitting
        // the filesystem, since the target may not exist yet), then enforce
        // containment under the root. This blocks `../escape.typ`.
        let joined = normalize_lexically(&root.join(rel));
        if !joined.starts_with(&root) {
            return Err(AppError::InvalidInput(format!(
                "{rel} escapes the workspace root"
            )));
        }
        Ok(joined)
    }

    /// List the immediate children of a workspace-relative directory.
    pub fn read_dir(&self, rel: &str) -> Result<Vec<DirEntry>> {
        let root = self.root.read().clone().ok_or_else(|| {
            AppError::InvalidInput("no workspace open".into())
        })?;
        let dir = self.resolve_rel(rel)?;
        fs_read_dir(&root, &dir)
    }

    /// Create a file or directory at a workspace-relative path.
    pub fn create_entry(&self, rel: &str, kind: EntryKind) -> Result<()> {
        let path = self.resolve_rel(rel)?;
        match kind {
            EntryKind::Dir => {
                std::fs::create_dir_all(&path).map_err(|e| AppError::Io(e))?;
            }
            EntryKind::File => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| AppError::Io(e))?;
                }
                std::fs::write(&path, "").map_err(|e| AppError::Io(e))?;
            }
        }
        Ok(())
    }

    /// Rename/move `from_rel` to `to_rel` (both workspace-relative). Works for
    /// files and directories.
    pub fn rename_entry(&self, from_rel: &str, to_rel: &str) -> Result<()> {
        let from = self.resolve_rel(from_rel)?;
        let to = self.resolve_rel(to_rel)?;
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Io(e))?;
        }
        std::fs::rename(&from, &to).map_err(|e| AppError::Io(e))?;
        Ok(())
    }

    /// Delete a file or directory (recursively) at a workspace-relative path.
    pub fn delete_entry(&self, rel: &str) -> Result<()> {
        let path = self.resolve_rel(rel)?;
        let meta = std::fs::symlink_metadata(&path).map_err(|e| AppError::Io(e))?;
        let res = if meta.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        res.map_err(|e| AppError::Io(e))?;
        Ok(())
    }

    /// Read a `.typ` file's text by absolute path (for `open_file_by_path`).
    /// The command layer pairs this with the resolver to open a workspace-backed
    /// tab.
    pub fn read_file_text(&self, abs_path: &Path) -> Result<String> {
        std::fs::read_to_string(abs_path).map_err(|e| AppError::Io(e))
    }
}

impl Default for WorkspaceService {
    fn default() -> Self {
        Self::new()
    }
}

/// Lexically normalize a path: resolve `.` and `..` components without touching
/// the filesystem (so it works for not-yet-existing paths). Used to make the
/// workspace-containment check robust against `..` escapes.
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // Pop the last normal component if any; leave `..` only at the
                // root (which would escape — that's caught by the caller).
                match out.last() {
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    _ => out.push(comp),
                }
            }
            other => out.push(other),
        }
    }
    out.iter().map(|c| c.as_os_str()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    fn tmp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("typst-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // A no-op fs-change callback for tests (the watcher still runs, but we
    // ignore its output here).
    fn noop_on_change() -> watcher::OnChange {
        Arc::new(|_paths: &[PathBuf]| {})
    }

    #[test]
    fn open_sets_root_and_resolver() {
        let dir = tmp_dir();
        std::fs::write(dir.join("main.typ"), "x").unwrap();
        let ws = WorkspaceService::new();
        assert!(!ws.is_open());
        let meta = ws.open(dir.clone(), noop_on_change()).unwrap();
        assert!(ws.is_open());
        assert_eq!(meta.name, dir.file_name().unwrap().to_string_lossy());
        assert!(ws.resolver().is_some(), "opening must seed a resolver");
        ws.close();
        assert!(!ws.is_open());
        assert!(ws.resolver().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_dir_lists_children() {
        let dir = tmp_dir();
        std::fs::write(dir.join("a.typ"), "x").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let entries = ws.read_dir("").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"sub"), "dirs should appear: {names:?}");
        assert!(names.contains(&"a.typ"), "files should appear: {names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_entry_creates_file_and_dir() {
        let dir = tmp_dir();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        ws.create_entry("new.typ", EntryKind::File).unwrap();
        ws.create_entry("newdir", EntryKind::Dir).unwrap();
        assert!(dir.join("new.typ").exists());
        assert!(dir.join("newdir").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_entry_moves_a_file() {
        let dir = tmp_dir();
        std::fs::write(dir.join("a.typ"), "x").unwrap();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        ws.rename_entry("a.typ", "b.typ").unwrap();
        assert!(!dir.join("a.typ").exists());
        assert!(dir.join("b.typ").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_entry_removes_file_and_dir() {
        let dir = tmp_dir();
        std::fs::write(dir.join("gone.typ"), "x").unwrap();
        std::fs::create_dir_all(dir.join("gonedir")).unwrap();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        ws.delete_entry("gone.typ").unwrap();
        ws.delete_entry("gonedir").unwrap();
        assert!(!dir.join("gone.typ").exists());
        assert!(!dir.join("gonedir").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_rel_rejects_path_escape() {
        let dir = tmp_dir();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        assert!(ws.resolve_rel("../escape.typ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn operations_without_workspace_error() {
        let ws = WorkspaceService::new();
        assert!(ws.read_dir("").is_err(), "read_dir needs an open workspace");
        assert!(ws.create_entry("x", EntryKind::File).is_err());
    }

    #[test]
    fn watcher_fires_on_change_via_open() {
        let dir = tmp_dir();
        let received: Arc<StdMutex<Vec<PathBuf>>> = Arc::new(StdMutex::new(Vec::new()));
        let received_cb = Arc::clone(&received);
        let on_change: watcher::OnChange = Arc::new(move |paths: &[PathBuf]| {
            received_cb.lock().unwrap().extend_from_slice(paths);
        });
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), on_change).unwrap();
        // Mutate; the watcher should report it within a few debounce windows.
        std::fs::write(dir.join("changed.typ"), "y").unwrap();
        let mut seen = false;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let got = received.lock().unwrap().clone();
            if got.iter().any(|p| p.ends_with("changed.typ")) {
                seen = true;
                break;
            }
        }
        assert!(seen, "workspace watcher should report the change");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
