//! `DocumentId`, document origin, and document metadata.
//!
//! ## Document identity (§4.1)
//!
//! [`DocumentId`] is stable for the lifetime an open document. Untitled saves,
//! Save As, and resolution-scope changes do **not** mint a new id — the same
//! [`DocumentId`] follows the document across origin transitions. This is why
//! [`DocumentMeta::from_path`] is deprecated for Save As: it generates a fresh
//! id. New code builds metadata via [`DocumentMeta::with_path`] (which keeps a
//! caller-supplied id) and sets [`DocumentOrigin`] explicitly.

use std::path::{Path, PathBuf};

use uuid::Uuid;

/// Unique identifier for an open document.
///
/// Wraps a `Uuid` v4. Serialized as a string across IPC. Stable for the
/// document's entire open lifetime — origin transitions (Untitled → save,
/// WorkspaceFile ↔ LooseFile) preserve the id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(type = "string", export_to = "../../src/lib/types.ts")
)]
pub struct DocumentId(pub Uuid);

impl DocumentId {
    /// Generate a fresh random id.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for DocumentId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for DocumentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for DocumentId {
    fn from(u: Uuid) -> Self {
        Self(u)
    }
}

impl From<DocumentId> for Uuid {
    fn from(id: DocumentId) -> Self {
        id.0
    }
}

/// Identifier for the currently active workspace (§4.2 / §4.3).
///
/// Owned by `WorkspaceService`; embedded in [`DocumentOrigin::WorkspaceFile`]
/// so a document knows which workspace owns it. When a workspace closes, its
/// `WorkspaceFile`s become `LooseFile`s, dropping this id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(type = "string", export_to = "../../src/lib/types.ts")
)]
pub struct WorkspaceId(pub Uuid);

impl WorkspaceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for WorkspaceId {
    fn default() -> Self {
        Self::new()
    }
}

/// External-modification conflict state for a document (§8.4).
///
/// Set by [`EditorService::handle_external_change`](crate::service::editor_service::EditorService::handle_external_change)
/// when a filesystem watcher reports a change to a document's backing file.
/// The user resolves a `Modified` / `Missing` state via explicit actions (use
/// disk, overwrite disk, Save As); the resolution UI is out of scope for the
/// state-tracking layer — this enum is just the data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
#[serde(rename_all = "lowercase")]
pub enum ConflictState {
    /// No conflict; in sync with disk (or untitled / no disk backing).
    #[default]
    None,
    /// Disk content differs from the buffer AND the buffer has unsaved edits.
    /// The user must decide: compare / use disk / overwrite disk. The buffer is
    /// left untouched (never silently clobbered).
    Modified,
    /// The backing file was deleted on disk. The buffer is preserved; Save
    /// rebuilds it, Save As writes elsewhere.
    Missing,
}

/// How a document is anchored on disk (§4.2).
///
/// Drives relative-resource resolution (`#include`, `#image()`), file
/// watching, and LSP folder association. Transitions between variants
/// preserve the [`DocumentId`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentOrigin {
    /// No disk backing. No relative-resource resolution. After save, converts
    /// to [`WorkspaceFile`](Self::WorkspaceFile) or
    /// [`LooseFile`](Self::LooseFile) depending on the target path.
    Untitled,
    /// A file inside the active workspace root. Relative resources resolve
    /// against the workspace root.
    WorkspaceFile {
        /// Canonical absolute path of the file.
        path: PathBuf,
        /// Owning workspace. Used to re-classify on workspace open/close.
        workspace_id: WorkspaceId,
    },
    /// A file outside the active workspace (or with no workspace open).
    /// Relative resources resolve against the file's parent directory.
    LooseFile {
        /// Canonical absolute path of the file.
        path: PathBuf,
        /// Resolution root: the file's parent directory.
        root: PathBuf,
    },
}

impl DocumentOrigin {
    /// The canonical disk path, if any (`None` for [`Untitled`](Self::Untitled)).
    pub fn canonical_path(&self) -> Option<&Path> {
        match self {
            DocumentOrigin::Untitled => None,
            DocumentOrigin::WorkspaceFile { path, .. }
            | DocumentOrigin::LooseFile { path, .. } => Some(path),
        }
    }

    /// The resolution root for `#include` / `#image()`: the workspace root for
    /// [`WorkspaceFile`](Self::WorkspaceFile), the parent dir for
    /// [`LooseFile`](Self::LooseFile), `None` for
    /// [`Untitled`](Self::Untitled).
    pub fn resolution_root(&self) -> Option<&Path> {
        match self {
            DocumentOrigin::Untitled => None,
            DocumentOrigin::WorkspaceFile { path, .. } => path.parent(),
            DocumentOrigin::LooseFile { root, .. } => Some(root),
        }
    }

    /// `true` for [`Untitled`](Self::Untitled).
    pub fn is_untitled(&self) -> bool {
        matches!(self, DocumentOrigin::Untitled)
    }
}

/// Metadata for an open document. Independent of typst's own `Document`.
///
/// `path` and `title` are retained as convenience fields derived from
/// [`DocumentOrigin`] for IPC consumers; the authoritative classification is
/// `origin`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DocumentMeta {
    /// Stable unique id for this document (preserved across origin transitions).
    pub id: DocumentId,
    /// Filesystem path, if backed by a file. `None` for untitled docs.
    /// Derived from [`DocumentOrigin::canonical_path`].
    #[cfg_attr(feature = "export-types", ts(type = "string | null"))]
    pub path: Option<PathBuf>,
    /// Display title (filename or "Untitled").
    pub title: String,
    /// Unsaved-changes flag.
    pub dirty: bool,
    /// Origin classification (§4.2). Drives resolution / watching / LSP.
    pub origin: DocumentOrigin,
    /// Monotonic content revision. Bumped on every `update_text`. Carried by
    /// compile/diagnostics/status events so stale results can be discarded.
    /// `u64` maps to `bigint` by default in ts-rs, but Tauri serializes it as a
    /// JSON number at runtime — override to `number` to match the wire format.
    #[serde(default)]
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub revision: u64,
    /// External-modification conflict state (§8.4). `None` when in sync with
    /// disk; `Modified` / `Missing` when the watcher detected an external disk
    /// change that could not be auto-applied (dirty buffer / deleted file).
    #[serde(default)]
    pub conflict: ConflictState,
}

impl DocumentMeta {
    /// Derive a display title from a path's full file name (e.g. `main.typ`).
    fn title_from_path(path: &Path) -> String {
        path.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Untitled".to_string())
    }

    /// Build an untitled metadata with a fresh id and revision 0.
    pub fn new_untitled() -> Self {
        Self {
            id: DocumentId::new(),
            path: None,
            title: "Untitled".to_string(),
            dirty: false,
            origin: DocumentOrigin::Untitled,
            revision: 0,
            conflict: ConflictState::None,
        }
    }

    /// Build metadata for a workspace file, keeping the supplied `id`
    /// (no fresh id minted).
    pub fn with_workspace_path(id: DocumentId, path: PathBuf, workspace_id: WorkspaceId) -> Self {
        let title = Self::title_from_path(&path);
        Self {
            id,
            path: Some(path.clone()),
            title,
            dirty: false,
            origin: DocumentOrigin::WorkspaceFile { path, workspace_id },
            revision: 0,
            conflict: ConflictState::None,
        }
    }

    /// Build metadata for a loose file (outside any workspace), keeping the
    /// supplied `id`. `root` is the resolution root (usually the file's parent).
    pub fn with_loose_path(id: DocumentId, path: PathBuf, root: PathBuf) -> Self {
        let title = Self::title_from_path(&path);
        Self {
            id,
            path: Some(path.clone()),
            title,
            dirty: false,
            origin: DocumentOrigin::LooseFile { path, root },
            revision: 0,
            conflict: ConflictState::None,
        }
    }

    /// **Deprecated for Save As.** Create a document from a filesystem path,
    /// deriving the title and minting a **fresh** `DocumentId`.
    ///
    /// The fresh id violates §4.1's "id stable across Save As" rule, so this is
    /// retained only for the initial open path. Use
    /// [`with_workspace_path`](Self::with_workspace_path) /
    /// [`with_loose_path`](Self::with_loose_path) when the id must be
    /// preserved.
    #[deprecated(note = "use with_workspace_path / with_loose_path to preserve the id")]
    pub fn from_path(path: PathBuf) -> Self {
        let title = Self::title_from_path(&path);
        // Without workspace context we cannot classify — fall back to a loose
        // file whose root is its parent. Callers in the open path should
        // instead classify against the active workspace.
        let root = path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        Self {
            id: DocumentId::new(),
            path: Some(path.clone()),
            title,
            dirty: false,
            origin: DocumentOrigin::LooseFile { path, root },
            revision: 0,
            conflict: ConflictState::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        DocumentId::export(&cfg).unwrap();
        WorkspaceId::export(&cfg).unwrap();
        // DocumentOrigin must be exported because DocumentMeta references it;
        // ts-rs only emits types that are explicitly exported, so a referenced
        // but un-exported type would leave an undefined name in types.ts.
        DocumentOrigin::export(&cfg).unwrap();
        // ConflictState must be exported because DocumentMeta references it;
        // like DocumentOrigin, an un-exported referenced type would leave an
        // undefined name in types.ts.
        ConflictState::export(&cfg).unwrap();
        DocumentMeta::export(&cfg).unwrap();
    }

    #[test]
    fn smoke() {
        let id1 = DocumentId::new();
        let id2 = DocumentId::new();
        assert_ne!(id1, id2, "fresh ids should be distinct");

        let untitled = DocumentMeta::new_untitled();
        assert!(untitled.path.is_none());
        assert_eq!(untitled.title, "Untitled");
        assert!(!untitled.dirty);
        assert!(untitled.origin.is_untitled());
        assert_eq!(untitled.revision, 0);
        assert!(untitled.origin.canonical_path().is_none());
        // Round-trip through the newtype.
        let u: Uuid = id1.into();
        assert_eq!(DocumentId::from(u), id1);
    }

    #[test]
    fn workspace_path_preserves_id_and_classifies() {
        let id = DocumentId::new();
        let ws = WorkspaceId::new();
        let path = PathBuf::from("/tmp/book/main.typ");
        let meta = DocumentMeta::with_workspace_path(id, path.clone(), ws);
        assert_eq!(meta.id, id, "id must be preserved, not regenerated");
        assert_eq!(meta.origin, DocumentOrigin::WorkspaceFile { path: path.clone(), workspace_id: ws });
        assert_eq!(meta.origin.canonical_path(), Some(path.as_path()));
        // Resolution root is the workspace root (parent of the file).
        assert_eq!(meta.origin.resolution_root(), Some(Path::new("/tmp/book")));
    }

    #[test]
    fn loose_path_uses_parent_as_resolution_root() {
        let id = DocumentId::new();
        let path = PathBuf::from("/docs/standalone.typ");
        let root = PathBuf::from("/docs");
        let meta = DocumentMeta::with_loose_path(id, path.clone(), root.clone());
        assert_eq!(meta.id, id);
        assert_eq!(meta.origin, DocumentOrigin::LooseFile { path, root });
        assert_eq!(meta.origin.resolution_root(), Some(Path::new("/docs")));
    }

    #[test]
    #[allow(deprecated)]
    fn from_path_backcompat_mints_fresh_id_and_loose_origin() {
        // from_path is retained for the initial open path; it mints a fresh id
        // (which is why Save As must not use it) and falls back to a loose
        // classification with the parent as root.
        let meta = DocumentMeta::from_path(PathBuf::from("/x/notes.typ"));
        assert!(meta.path.is_some());
        assert_eq!(meta.title, "notes.typ");
        assert!(matches!(meta.origin, DocumentOrigin::LooseFile { .. }));
        assert_eq!(meta.origin.resolution_root(), Some(Path::new("/x")));
    }
}
