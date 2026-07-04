//! Directory scanning for the workspace file tree.
//!
//! The tree is loaded **lazily**: [`read_dir`] returns only the immediate
//! children of a directory (one level deep). The frontend expands a folder by
//! calling `read_dir` again on that subpath. This keeps large workspaces cheap
//! and matches how a tree UI actually requests data.
//!
//! Hidden files (leading `.`), common VCS/build noise (`.git`, `target`,
//! `node_modules`), and non-`.typ` entries are still listed — the frontend
//! decides what to show; the backend only hides a small set of always-noise
//! directories to avoid feeding thousands of `target/` entries to the UI.

use std::path::Path;

use crate::error::{AppError, Result};

/// Whether a tree entry is a file or a directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

/// A single entry returned by [`read_dir`]: one child of a directory.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DirEntry {
    /// Path relative to the workspace root, using `/` separators.
    /// Empty string for the root itself.
    pub relative: String,
    /// Entry name (last path component).
    pub name: String,
    pub kind: EntryKind,
}

/// Directories that are always noise — never listed in the tree. We don't prune
/// by file extension (the frontend may want to show `.png` assets next to
/// `.typ` sources); only by these well-known heavy/hidden dirs.
pub(crate) const IGNORED_DIRS: &[&str] = &[".git", "target", "node_modules"];

/// List the immediate children of `dir` (relative to `root`), excluding the
/// always-ignored directories. Returns an empty vec for a file or missing path.
///
/// Directories sort before files; entries of the same kind sort alphabetically
/// (case-insensitive) for a stable tree.
pub fn read_dir(root: &Path, dir: &Path) -> Result<Vec<DirEntry>> {
    let abs = if dir.is_absolute() {
        dir.to_path_buf()
    } else if dir.as_os_str().is_empty() || dir == Path::new(".") {
        root.to_path_buf()
    } else {
        root.join(dir)
    };

    let read = match std::fs::read_dir(&abs) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(e)),
    };

    let mut entries: Vec<DirEntry> = read
        .filter_map(|res| {
            let entry = res.ok()?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_string();
            if IGNORED_DIRS.contains(&name.as_str()) {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            let kind = if file_type.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };
            // Relative path from root, with forward slashes for the frontend.
            let relative = rel_with_slashes(root, &entry.path());
            Some(DirEntry {
                relative,
                name,
                kind,
            })
        })
        .collect();

    // Directories first, then files; alphabetical within each group.
    entries.sort_by(|a, b| {
        b.kind
            .cmp(&a.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Compute `path` relative to `root` as a `/`-joined string. Falls back to the
/// file name if the path is not lexically under `root`.
fn rel_with_slashes(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tree(root: &Path, layout: &[&str]) {
        for rel in layout {
            let p = root.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            if rel.ends_with('/') {
                std::fs::create_dir_all(&p).unwrap();
            } else {
                std::fs::write(&p, b"x").unwrap();
            }
        }
    }

    #[test]
    fn read_dir_lists_immediate_children_dirs_first() {
        let root = std::env::temp_dir().join(format!("typst-tree-{}", uuid::Uuid::new_v4()));
        make_tree(
            &root,
            &["zeta.typ", "alpha.typ", "sub/", "sub/inner.typ", "assets/"],
        );
        let entries = read_dir(&root, Path::new("")).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories first (alphabetical), then files (alphabetical).
        assert_eq!(names, vec!["assets", "sub", "alpha.typ", "zeta.typ"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_dir_skips_ignored_dirs() {
        let root = std::env::temp_dir().join(format!("typst-tree-{}", uuid::Uuid::new_v4()));
        make_tree(&root, &["main.typ", ".git/", "target/", "node_modules/"]);
        let entries = read_dir(&root, Path::new("")).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["main.typ"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_dir_on_subdir_lists_its_children() {
        let root = std::env::temp_dir().join(format!("typst-tree-{}", uuid::Uuid::new_v4()));
        make_tree(&root, &["sub/", "sub/inner.typ", "sub/deeper/", "main.typ"]);
        let entries = read_dir(&root, Path::new("sub")).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // sub's children: deeper (dir) + inner.typ (file)
        assert_eq!(names, vec!["deeper", "inner.typ"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_dir_missing_returns_empty_not_error() {
        let root = std::env::temp_dir().join(format!("typst-tree-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let entries = read_dir(&root, Path::new("does-not-exist")).unwrap();
        assert!(entries.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        EntryKind::export(&cfg).unwrap();
        DirEntry::export(&cfg).unwrap();
    }
}
