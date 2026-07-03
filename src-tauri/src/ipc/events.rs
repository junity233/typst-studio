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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CompiledPayload {
    pub id: DocumentId,
    pub pages: Vec<String>,
    /// Source line → preview-page bbox index, sorted by `(page, y)`. Empty for
    /// documents with no rendered text (or when compilation produced no doc).
    pub line_map: Vec<LineRect>,
    /// `u64` maps to `bigint` by default in ts-rs, but Tauri serializes it as a
    /// JSON number at runtime — override to `number` to match the contract.
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub duration_ms: u64,
}

/// Payload of the `diagnostics` event.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DiagnosticsPayload {
    pub id: DocumentId,
    pub diagnostics: Vec<Diagnostic>,
}

/// Payload of the `status` event. `duration_ms` is present only on
/// `Success` / `Error`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct StatusPayload {
    pub id: DocumentId,
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
        // Workspace + tree types (defined outside `events` but exported here as
        // the single ts-rs generation entry point).
        crate::service::workspace_service::WorkspaceMeta::export(&cfg).unwrap();
        crate::fs::tree::DirEntry::export(&cfg).unwrap();
        crate::fs::tree::EntryKind::export(&cfg).unwrap();
    }

    #[test]
    fn compiled_payload_is_camel_case() {
        let payload = CompiledPayload {
            id: DocumentId::new(),
            pages: vec!["<svg/>".to_string()],
            line_map: Vec::new(),
            duration_ms: 7,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"durationMs\""), "camelCase field expected: {json}");
        assert!(json.contains("\"pages\""));
        assert!(json.contains("\"lineMap\""), "camelCase field expected: {json}");
        assert!(json.contains("\"id\""));
    }
}
