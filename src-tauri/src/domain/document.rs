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

/// External-modification conflict state for a document (§5.4 / §8.4).
///
/// Set by [`EditorService::handle_external_change`](crate::service::editor_service::EditorService::handle_external_change)
/// when a filesystem watcher reports a change to a document's backing file.
/// The user resolves a non-`None` state via explicit actions (use disk /
/// overwrite disk / Save As / discard); the resolution UI is out of scope for
/// the state-tracking layer — this enum is just the data.
///
/// ## Wire format (§5.4 — string-tag only)
///
/// On the wire this serializes as a **bare lowercase string** —
/// `"none" / "modified" / "missing" / "permission_changed" / "replaced"` — so
/// the frontend can keep treating `ConflictState` as a string-literal union.
/// The carried `disk_version` ([`Modified`]) and `identity_changed`
/// ([`Replaced`]) are Rust-side ONLY (kept in-memory for re-detection; not
/// serialized) — they are populated from disk reads, not from IPC. This keeps
/// the wire form backward-compatible with the pre-§5.4 frontend (which was a
/// 3-variant string union) and avoids a struct-per-variant churn.
///
/// The serialization is hand-written (rather than `#[serde(rename_all=…)]`)
/// because serde's derive can't express "drop the variant's data and emit only
/// the tag" for a struct variant enum — `rename_all` would emit the tag for a
/// unit enum, but the moment `Modified` gains a field it becomes an internally
/// tagged struct on the wire. The custom [`serde::Serialize`] / [`serde::Deserialize`]
/// impls below give exactly the desired string-only shape, and [`tag`] / [`from_tag`]
/// are the single source of truth for the mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    // The frontend type is a string-literal union — the wire form is a bare
    // string tag, NOT an internally-tagged struct (see the custom serde impls).
    ts(type = "\"none\" | \"modified\" | \"missing\" | \"permission_changed\" | \"replaced\"", export_to = "../../src/lib/types.ts")
)]
pub enum ConflictState {
    /// No conflict; in sync with disk (or untitled / no disk backing).
    #[default]
    None,
    /// Disk content differs from the buffer AND the buffer has unsaved edits.
    /// The user must decide: compare / use disk / overwrite disk. The buffer is
    /// left untouched (never silently clobbered). `disk_version` records the
    /// on-disk identity captured at detection time, so a re-detection that
    /// re-reads the same bytes knows the conflict is still current (and so
    /// `resolve_conflict_use_disk` can clear the flag once the buffer matches
    /// it). Rust-side only — not serialized.
    Modified {
        /// The on-disk content identity at detection time. Rust-side only.
        disk_version: Option<crate::domain::disk_version::DiskVersion>,
    },
    /// The backing file was deleted on disk. The buffer is preserved; the user
    /// can recreate it (write to the same path) or Save As elsewhere.
    Missing,
    /// The backing file became unreadable (permission revoked / read-only) but
    /// still exists on disk. The buffer is preserved; in-place save is blocked
    /// until the user fixes permissions or Save-As elsewhere.
    PermissionChanged,
    /// The backing file was *replaced* — an external tool rewrote it with the
    /// SAME bytes but a NEW inode (e.g. `sed -i`, an atomic write-then-rename).
    /// `identity_changed` is `true` when the inode genuinely differs from the
    /// stored one; `false` is reserved for a future "content + inode both
    /// unchanged, mtime-only" refinement (currently this case is a no-op
    /// upstream). §5.4 "文件被替换为不同 identity 时按外部替换处理，不能只比较
    /// 时间戳".
    Replaced { identity_changed: bool },
}

impl ConflictState {
    /// The bare lowercase string tag this variant serializes to on the wire
    /// (the single source of truth for the [`Serialize`] / [`Deserialize`] impls).
    pub fn tag(&self) -> &'static str {
        match self {
            ConflictState::None => "none",
            ConflictState::Modified { .. } => "modified",
            ConflictState::Missing => "missing",
            ConflictState::PermissionChanged => "permission_changed",
            ConflictState::Replaced { .. } => "replaced",
        }
    }

    /// Parse a wire tag back into the variant, with any carried data defaulted
    /// (the data is Rust-side only and re-populated by detection). `None` for an
    /// unknown tag (callers treat that as a recoverable error).
    pub fn from_tag(tag: &str) -> Option<Self> {
        Some(match tag {
            "none" => ConflictState::None,
            "modified" => ConflictState::Modified { disk_version: None },
            "missing" => ConflictState::Missing,
            "permission_changed" => ConflictState::PermissionChanged,
            "replaced" => ConflictState::Replaced { identity_changed: false },
            _ => return None,
        })
    }

    /// `true` for any non-`None` variant (i.e. an active conflict that blocks
    /// the in-place save gate, §5.4).
    pub fn is_active(&self) -> bool {
        !matches!(self, ConflictState::None)
    }
}

impl serde::Serialize for ConflictState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Emit ONLY the bare string tag — the carried data stays Rust-side.
        serializer.serialize_str(self.tag())
    }
}

impl<'de> serde::Deserialize<'de> for ConflictState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ConflictStateVisitor;
        impl<'de> serde::de::Visitor<'de> for ConflictStateVisitor {
            type Value = ConflictState;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a conflict-state string tag")
            }

            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                ConflictState::from_tag(v)
                    .ok_or_else(|| E::custom(format!("unknown conflict state `{v}`")))
            }
        }
        deserializer.deserialize_str(ConflictStateVisitor)
    }
}

/// What kind of content an open document holds. Drives everything that should
/// differ between Typst source and other openable files (PDF / image previews,
/// plain-text/markdown editing, whether to compile, whether to attach the LSP).
///
/// Defaults to [`Typst`](Self::Typst) so existing constructors and any path
/// that doesn't explicitly classify produce the historical behavior — the
/// whole app remains a Typst editor unless a recognized non-`.typ` extension
/// opts a document into another kind.
///
/// ## Wire format — bare lowercase string tag
///
/// On the wire this serializes as a **bare lowercase string** —
/// `"typst" / "text" / "markdown" / "image" / "pdf"` — so the frontend treats
/// `DocumentKind` as a simple string-literal union. The serialization is
/// hand-written (custom `Serialize`/`Deserialize` impls below) rather than
/// `#[serde(rename_all = "lowercase")]` because ts-rs's `type = ...` override
/// (which keeps the generated TS as a literal union) is incompatible with
/// serde's `rename_all` in the same attribute block. This mirrors how
/// [`ConflictState`] achieves its bare-string-tag wire form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(
        type = "\"typst\" | \"text\" | \"markdown\" | \"image\" | \"pdf\"",
        export_to = "../../src/lib/types.ts"
    )
)]
pub enum DocumentKind {
    /// Typst source. Compiled on every edit; tinymist LSP attaches; the SVG
    /// preview pane renders. The historical and default behavior.
    #[default]
    Typst,
    /// Editable plain text that is NOT Typst (txt/json/csv/log/ts/py/...).
    /// Opened in Monaco with per-extension syntax highlighting when Monaco
    /// knows the language, `plaintext` otherwise. No compile, no LSP.
    Text,
    /// Markdown source. Edited in Monaco (language = `markdown`) and shown
    /// beside a rendered-markdown preview. No Typst compile, no LSP.
    Markdown,
    /// A raster/vector image (png/jpg/jpeg/gif/svg/webp/bmp). Preview-only.
    /// Bytes are read on demand by the frontend via the `read_file_bytes`
    /// command — the backend never holds the bytes.
    Image,
    /// A PDF document. Preview-only, rendered in-app by pdf.js. Like `Image`,
    /// bytes are read on demand by the frontend.
    Pdf,
}

impl DocumentKind {
    /// The bare lowercase string tag this variant serializes to on the wire
    /// (single source of truth for the custom `Serialize`/`Deserialize` impls).
    pub fn tag(self) -> &'static str {
        match self {
            DocumentKind::Typst => "typst",
            DocumentKind::Text => "text",
            DocumentKind::Markdown => "markdown",
            DocumentKind::Image => "image",
            DocumentKind::Pdf => "pdf",
        }
    }

    /// Parse a wire tag into the variant. `None` for an unknown tag.
    pub fn from_tag(tag: &str) -> Option<Self> {
        Some(match tag {
            "typst" => DocumentKind::Typst,
            "text" => DocumentKind::Text,
            "markdown" => DocumentKind::Markdown,
            "image" => DocumentKind::Image,
            "pdf" => DocumentKind::Pdf,
            _ => return None,
        })
    }

    /// `true` for the preview-only kinds ([`Image`](Self::Image) /
    /// [`Pdf`](Self::Pdf)). Such documents are not editable, never dirty, and
    /// never compiled.
    pub fn is_binary_preview(self) -> bool {
        matches!(self, DocumentKind::Image | DocumentKind::Pdf)
    }

    /// `true` only for the historical Typst behavior. Used to gate compile /
    /// LSP / VFS / worker creation so non-Typst documents skip that pipeline.
    pub fn is_typst(self) -> bool {
        matches!(self, DocumentKind::Typst)
    }

    /// `true` for the Monaco-editable text kinds ([`Text`](Self::Text) /
    /// [`Markdown`](Self::Markdown)) plus Typst. Used to decide whether the
    /// backend should keep a text buffer + accept `update_text`.
    pub fn is_textual(self) -> bool {
        matches!(
            self,
            DocumentKind::Typst | DocumentKind::Text | DocumentKind::Markdown
        )
    }
}

impl serde::Serialize for DocumentKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.tag())
    }
}

impl<'de> serde::Deserialize<'de> for DocumentKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct DocumentKindVisitor;
        impl<'de> serde::de::Visitor<'de> for DocumentKindVisitor {
            type Value = DocumentKind;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a document-kind string tag")
            }

            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                DocumentKind::from_tag(v)
                    .ok_or_else(|| E::custom(format!("unknown document kind `{v}`")))
            }
        }
        deserializer.deserialize_str(DocumentKindVisitor)
    }
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
    /// What kind of content this document holds (Typst source, plain/markdown
    /// text, image, pdf). Defaults to [`DocumentKind::Typst`] so legacy
    /// payloads / constructors stay Typst. The open path classifies by file
    /// extension; non-Typst kinds skip compile / LSP / VFS seeding.
    #[serde(default)]
    pub kind: DocumentKind,
    /// Whether this document is soft-closed (hidden from the tab strip but kept
    /// alive in the background for instant reactivation). Defaults to `false`.
    /// Soft-close preserves the worker, EditorWorld, cached compile result, and
    /// registry entry so reopening the file is instantaneous. The frontend's LRU
    /// policy eventually upgrades old hidden docs to a true close
    /// ([`hard_close`](crate::service::document_service::DocumentService::hard_close)).
    #[serde(default)]
    pub hidden: bool,
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
            kind: DocumentKind::Typst,
            hidden: false,
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
            kind: DocumentKind::Typst,
            hidden: false,
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
            kind: DocumentKind::Typst,
            hidden: false,
        }
    }

    /// Builder-style: override the content kind. Used by the open path after
    /// classifying the file by extension (e.g. a `.pdf` becomes
    /// [`DocumentKind::Pdf`]). Returns a new meta; the default constructors
    /// always set [`DocumentKind::Typst`], so this is the single mutation
    /// point for non-Typst kinds.
    pub fn with_kind(mut self, kind: DocumentKind) -> Self {
        self.kind = kind;
        self
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
            kind: DocumentKind::Typst,
            hidden: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `DocumentKind` serializes as a bare lowercase string tag (mirroring
    /// `ConflictState`'s wire contract), so the frontend keeps a simple
    /// string-literal union.
    #[test]
    fn document_kind_serializes_as_bare_string_tag() {
        assert_eq!(
            serde_json::to_value(DocumentKind::Typst).unwrap(),
            serde_json::Value::String("typst".into())
        );
        assert_eq!(
            serde_json::to_value(DocumentKind::Text).unwrap(),
            serde_json::Value::String("text".into())
        );
        assert_eq!(
            serde_json::to_value(DocumentKind::Markdown).unwrap(),
            serde_json::Value::String("markdown".into())
        );
        assert_eq!(
            serde_json::to_value(DocumentKind::Image).unwrap(),
            serde_json::Value::String("image".into())
        );
        assert_eq!(
            serde_json::to_value(DocumentKind::Pdf).unwrap(),
            serde_json::Value::String("pdf".into())
        );
    }

    #[test]
    fn document_kind_round_trips_through_the_string_tag() {
        for original in [
            DocumentKind::Typst,
            DocumentKind::Text,
            DocumentKind::Markdown,
            DocumentKind::Image,
            DocumentKind::Pdf,
        ] {
            let json = serde_json::to_string(&original).unwrap();
            let back: DocumentKind = serde_json::from_str(&json).unwrap();
            assert_eq!(back, original, "round-trip via {json:?}");
        }
        // Unknown tag → error (not a silent default).
        assert!(serde_json::from_str::<DocumentKind>("\"bogus\"").is_err());
    }

    #[test]
    fn document_kind_tag_helpers_are_inverses() {
        for tag in ["typst", "text", "markdown", "image", "pdf"] {
            let parsed = DocumentKind::from_tag(tag).expect("known tag parses");
            assert_eq!(parsed.tag(), tag);
        }
        assert!(DocumentKind::from_tag("nope").is_none());
    }

    #[test]
    fn document_kind_classification_predicates() {
        assert!(DocumentKind::Typst.is_typst());
        assert!(DocumentKind::Typst.is_textual());
        assert!(!DocumentKind::Typst.is_binary_preview());

        assert!(!DocumentKind::Text.is_typst());
        assert!(DocumentKind::Text.is_textual());
        assert!(!DocumentKind::Text.is_binary_preview());

        assert!(DocumentKind::Markdown.is_textual());
        assert!(!DocumentKind::Markdown.is_typst());

        assert!(DocumentKind::Image.is_binary_preview());
        assert!(!DocumentKind::Image.is_textual());
        assert!(DocumentKind::Pdf.is_binary_preview());
        assert!(!DocumentKind::Pdf.is_textual());
    }

    /// `DocumentKind::default()` is `Typst` and `#[serde(default)]` on
    /// `DocumentMeta.kind` means a legacy payload (no `kind` field) loads as
    /// Typst — keeping the historical behavior for old session/recovery blobs.
    #[test]
    fn document_kind_defaults_to_typst() {
        assert_eq!(DocumentKind::default(), DocumentKind::Typst);
    }

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
        // DocumentKind must be exported because DocumentMeta references it.
        DocumentKind::export(&cfg).unwrap();
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

    /// §5.4 wire contract: every `ConflictState` serializes as a BARE STRING
    /// tag (not an internally-tagged struct), even `Modified` / `Replaced`
    /// which carry Rust-side data. This is the whole point of the custom
    /// serde impl — the carried data is dropped on the wire so the frontend
    /// keeps a simple string-literal union.
    #[test]
    fn conflict_state_serializes_as_bare_string_tag() {
        // None → "none".
        assert_eq!(
            serde_json::to_value(ConflictState::None).unwrap(),
            serde_json::Value::String("none".into())
        );
        // Modified (even with carried data) → just "modified" — NO struct.
        let modified = ConflictState::Modified {
            disk_version: Some(crate::domain::disk_version::DiskVersion::from_bytes(b"x")),
        };
        let v = serde_json::to_value(modified).unwrap();
        assert_eq!(v, serde_json::Value::String("modified".into()), "Modified must serialize as the bare tag, dropping disk_version");
        assert!(
            !v.to_string().contains("disk_version"),
            "the carried disk_version must NOT appear on the wire: {v}"
        );
        assert_eq!(
            serde_json::to_value(ConflictState::Missing).unwrap(),
            serde_json::Value::String("missing".into())
        );
        assert_eq!(
            serde_json::to_value(ConflictState::PermissionChanged).unwrap(),
            serde_json::Value::String("permission_changed".into())
        );
        // Replaced drops identity_changed too.
        let replaced = ConflictState::Replaced { identity_changed: true };
        let v = serde_json::to_value(replaced).unwrap();
        assert_eq!(v, serde_json::Value::String("replaced".into()));
        assert!(
            !v.to_string().contains("identity_changed"),
            "the carried identity_changed must NOT appear on the wire: {v}"
        );
    }

    /// Deserializing a tag round-trips to the variant (carried data defaulted).
    #[test]
    fn conflict_state_round_trips_through_the_string_tag() {
        for original in [
            ConflictState::None,
            ConflictState::Modified { disk_version: None },
            ConflictState::Missing,
            ConflictState::PermissionChanged,
            ConflictState::Replaced { identity_changed: false },
        ] {
            let json = serde_json::to_string(&original).unwrap();
            let back: ConflictState = serde_json::from_str(&json).unwrap();
            // The carried data is dropped on the wire, so compare by tag only
            // (None == None, Modified{None} == Modified{None}, etc.).
            assert_eq!(back.tag(), original.tag(), "round-trip via {json:?}");
        }
        // An unknown tag is a deserialization error (not a silent default).
        let bad = serde_json::from_str::<ConflictState>("\"bogus\"");
        assert!(bad.is_err(), "unknown tag must error, not default");
    }

    #[test]
    fn conflict_state_is_active_and_tag_helpers() {
        assert!(!ConflictState::None.is_active());
        assert!(ConflictState::Missing.is_active());
        assert!(ConflictState::PermissionChanged.is_active());
        assert!(ConflictState::Modified { disk_version: None }.is_active());
        assert!(ConflictState::Replaced { identity_changed: true }.is_active());
        // tag() / from_tag() are inverses over the 5 known tags.
        for tag in ["none", "modified", "missing", "permission_changed", "replaced"] {
            let parsed = ConflictState::from_tag(tag).expect("known tag parses");
            assert_eq!(parsed.tag(), tag);
        }
        assert!(ConflictState::from_tag("nope").is_none());
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

    /// Every constructor must default `hidden` to `false` — a freshly
    /// opened/created document is always visible in the tab strip until the
    /// user soft-closes it.
    #[test]
    #[allow(deprecated)]
    fn constructors_default_hidden_false() {
        assert!(!DocumentMeta::new_untitled().hidden);
        let id = DocumentId::new();
        let ws = WorkspaceId::new();
        let p = PathBuf::from("/tmp/w.typ");
        assert!(!DocumentMeta::with_workspace_path(id, p.clone(), ws).hidden);
        assert!(
            !DocumentMeta::with_loose_path(id, p, PathBuf::from("/tmp")).hidden,
        );
        assert!(!DocumentMeta::from_path(PathBuf::from("/x/y.typ")).hidden);
    }

    /// `#[serde(default)]` on `hidden` means a legacy payload (one without the
    /// field) round-trips into `hidden: false`, so old persisted/recovery blobs
    /// and pre-§B1 frontend messages still deserialize.
    #[test]
    fn hidden_defaults_false_when_absent_on_the_wire() {
        // A pre-§B1 payload: no `hidden` key at all.
        let legacy = r#"{
            "id":"00000000-0000-0000-0000-000000000000",
            "path":null,
            "title":"Untitled",
            "dirty":false,
            "origin":{"kind":"untitled"},
            "revision":0,
            "conflict":"none"
        }"#;
        let meta: DocumentMeta = serde_json::from_str(legacy).unwrap();
        assert!(!meta.hidden, "absent hidden field must default to false");
        // And re-serializing emits it explicitly as false.
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v.get("hidden"), Some(&serde_json::Value::Bool(false)));
    }
}
