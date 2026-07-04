//! Tauri event payloads.
//!
//! These types are the wire format for the events emitted by the backend:
//! `compiled`, `diagnostics`, `status`, and `lsp_status`. All editor payloads
//! carry a `DocumentId` so the frontend can route events to the correct tab.
//!
//! Field names are `camelCase` on the wire (`#[serde(rename_all = "camelCase")]`)
//! so the generated TypeScript matches the frontend's `ui-types.ts` directly.
//!
//! `CompileStatus` is re-exported from `domain::compile_status` (see the `use`
//! below) so existing `ipc::events::CompileStatus` paths keep resolving.

use crate::domain::diagnostics::Diagnostic;
use crate::domain::document::{DocumentId, DocumentMeta};
use crate::domain::source_map::LineRect;

// `CompileStatus` is defined in `domain::compile_status` (moved out of this
// module to remove a `service → ipc` reverse dependency: the service layer emits
// statuses and must not import from `ipc`). Re-exported here so existing
// `ipc::events::CompileStatus` paths keep resolving, and so the `StatusPayload`
// field below compiles against the same type.
pub use crate::domain::compile_status::CompileStatus;

/// Response of `new_tab` / `open_file`: the tab's metadata paired with its
/// current source text, so the frontend can hydrate Monaco without re-reading
/// the file from disk.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct OpenedDocument {
    #[serde(flatten)]
    pub meta: DocumentMeta,
    pub content: String,
}

/// Payload of the `compiled` event: one self-contained SVG string per page,
/// plus a source map mapping each source line to its page-space bounding rect
/// (used by the frontend for scroll-sync and click-to-source).
///
/// `revision` (§7) is the document content revision this compile corresponds
/// to. The frontend discards results whose revision is older than the tab's
/// current revision, so a slow compile can never overwrite a newer preview.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CompiledPayload {
    pub id: DocumentId,
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub revision: u64,
    pub pages: Vec<String>,
    /// Source line → preview-page bbox index, sorted by `(page, y)`. Empty for
    /// documents with no rendered text (or when compilation produced no doc).
    pub line_map: Vec<LineRect>,
    /// `u64` maps to `bigint` by default in ts-rs, but Tauri serializes it as a
    /// JSON number at runtime — override to `number` to match the contract.
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub duration_ms: u64,
}

/// Payload of the `diagnostics` event. `revision` (§7) tags which buffer
/// revision the diagnostics correspond to.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DiagnosticsPayload {
    pub id: DocumentId,
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub revision: u64,
    pub diagnostics: Vec<Diagnostic>,
}

/// Payload of the `status` event. `duration_ms` is present only on
/// `Success` / `Error`. `revision` (§7) tags the buffer revision.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct StatusPayload {
    pub id: DocumentId,
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub revision: u64,
    pub status: CompileStatus,
    #[cfg_attr(feature = "export-types", ts(type = "number | null"))]
    pub duration_ms: Option<u64>,
}

/// Payload of the `lsp_status` event, emitted when the LSP connection
/// transitions (client connects / relay ends / tinymist exits). Lets the
/// frontend subscribe instead of polling `get_lsp_status`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct LspStatusPayload {
    pub running: bool,
    pub ws_url: String,
    pub available: bool,
}

/// Payload of the `fs_changed` event: paths (absolute) that changed on disk in
/// the workspace, detected by the filesystem watcher. The frontend refreshes
/// the affected parts of its file tree. Empty `paths` is a generic "something
/// changed, refresh" signal (used as a fallback).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct FsChangedPayload {
    /// Absolute paths that changed (created/modified/removed).
    pub paths: Vec<String>,
}

/// Payload of the `conflict` event (§8.4): an external disk change to an open
/// document's file moved it into a conflict state. `disk_content` is present
/// for `Modified` so the UI can show a diff; absent otherwise.
///
/// `revision` (§7) tags the buffer revision the conflict corresponds to.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ConflictPayload {
    pub id: DocumentId,
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub revision: u64,
    pub conflict: crate::domain::document::ConflictState,
    /// The current disk content, present on `Modified` (so the UI can show a
    /// diff). `None` for `None` / `Missing`.
    pub disk_content: Option<String>,
}

// --- Crash recovery (§5.1) --------------------------------------------------

/// One recoverable document surfaced to the UI at startup (§5.1.3). The backend
/// computes `disk_changed` by comparing the snapshot's recorded disk version to
/// the file's current on-disk version, so the UI can decide the default action
/// (recover the buffer vs. must-compare).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct RecoverableInfo {
    /// The document id from the snapshot (a uuid string).
    pub document_id: String,
    pub title: String,
    /// Canonical disk path, `None` for an Untitled snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    /// Unix-millis capture timestamp.
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub captured_at: i64,
    /// True iff the disk file's current content differs from the version the
    /// snapshot was captured against (or the file is missing). Drives the
    /// "must compare" default for disk-changed docs (§5.1.3).
    pub disk_changed: bool,
}

/// Payload of the `recovery_available` event (§5.1.3): emitted once at startup
/// when recoverable snapshots exist (no clean-shutdown marker, or a snapshot
/// newer than disk). The frontend shows a `RecoveryDialog` with one row per
/// snapshot.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct RecoveryAvailablePayload {
    pub snapshots: Vec<RecoverableInfo>,
}

/// Response of the `recover_document` IPC: enough to rebuild an in-memory
/// document from a snapshot WITHOUT writing disk (§5.1.3 "恢复只创建内存文档").
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct RecoveredDocument {
    pub document_id: String,
    /// The unsaved buffer content from the snapshot.
    pub content: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    /// Origin tag (`"untitled"` / `"workspace"` / `"loose"`).
    pub origin: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        // `CompileStatus` is exported by `domain::compile_status`.
        CompiledPayload::export(&cfg).unwrap();
        DiagnosticsPayload::export(&cfg).unwrap();
        StatusPayload::export(&cfg).unwrap();
        OpenedDocument::export(&cfg).unwrap();
        LspStatusPayload::export(&cfg).unwrap();
        FsChangedPayload::export(&cfg).unwrap();
        ConflictPayload::export(&cfg).unwrap();
        // Crash-recovery payloads (§5.1).
        RecoverableInfo::export(&cfg).unwrap();
        RecoveryAvailablePayload::export(&cfg).unwrap();
        RecoveredDocument::export(&cfg).unwrap();
        // DiskVersion is now serialized inside recovery snapshots.
        crate::domain::disk_version::DiskVersion::export(&cfg).unwrap();
        // CompareRecovery lives in recovery_commands but is an IPC wire type.
        crate::ipc::recovery_commands::CompareRecovery::export(&cfg).unwrap();
        // Workspace + tree types (defined outside `events` but exported here as
        // the single ts-rs generation entry point).
        crate::service::workspace_service::WorkspaceMeta::export(&cfg).unwrap();
        crate::fs::tree::DirEntry::export(&cfg).unwrap();
        crate::fs::tree::EntryKind::export(&cfg).unwrap();
        // Single-instance routing payloads (§6.1).
        crate::service::file_routing::FocusViewPayload::export(&cfg).unwrap();
        crate::service::file_routing::OpenExternalFilePayload::export(&cfg).unwrap();
        // Startup-problem payloads (§6.5).
        crate::startup::StartupProblem::export(&cfg).unwrap();
        crate::startup::StartupProblemsPayload::export(&cfg).unwrap();
    }

    #[test]
    fn compiled_payload_is_camel_case() {
        let payload = CompiledPayload {
            id: DocumentId::new(),
            revision: 3,
            pages: vec!["<svg/>".to_string()],
            line_map: Vec::new(),
            duration_ms: 7,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"durationMs\""), "camelCase field expected: {json}");
        assert!(json.contains("\"pages\""));
        assert!(json.contains("\"lineMap\""), "camelCase field expected: {json}");
        assert!(json.contains("\"id\""));
        assert!(json.contains("\"revision\""), "revision field expected: {json}");
    }
}
