//! `DocumentId` and document metadata.

use std::path::PathBuf;

use uuid::Uuid;

/// Unique identifier for an open document (tab).
///
/// Wraps a `Uuid` v4. Serialized as a string across IPC.
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

/// Metadata for an open document tab. Independent of typst's own `Document`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DocumentMeta {
    /// Stable unique id for this tab.
    pub id: DocumentId,
    /// Filesystem path, if backed by a file. `None` for unsaved/untitled docs.
    #[cfg_attr(feature = "export-types", ts(type = "string | null"))]
    pub path: Option<PathBuf>, // explicitly typed; export_to inherited
    /// Display title (filename or "Untitled").
    pub title: String,
    /// Unsaved-changes flag.
    pub dirty: bool,
}

impl DocumentMeta {
    /// Create a new untitled document (no path, `dirty = false`).
    pub fn new_untitled() -> Self {
        Self {
            id: DocumentId::new(),
            path: None,
            title: "Untitled".to_string(),
            dirty: false,
        }
    }

    /// Create a document from a filesystem path, deriving the title from
    /// the file name.
    pub fn from_path(path: PathBuf) -> Self {
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Untitled".to_string());
        Self {
            id: DocumentId::new(),
            path: Some(path),
            title,
            dirty: false,
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
        // Round-trip through the newtype.
        let u: Uuid = id1.into();
        assert_eq!(DocumentId::from(u), id1);
    }
}
