//! Tauri event payloads + `CompileStatus`.
//!
//! These types are the wire format for the three events emitted by the backend:
//! `compiled`, `diagnostics`, and `status` (see `ipc-contract.md`). All payloads
//! carry a `DocumentId` so the frontend can route events to the correct tab.
//!
//! Field names are `camelCase` on the wire (`#[serde(rename_all = "camelCase")]`)
//! so the generated TypeScript matches the frontend's `ui-types.ts` directly.

use crate::domain::diagnostics::Diagnostic;
use crate::domain::document::{DocumentId, DocumentMeta};

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

/// Lifecycle status of a compile, emitted on the `status` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum CompileStatus {
    Idle,
    Compiling,
    Success,
    Error,
}

/// Payload of the `compiled` event: one self-contained SVG string per page.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        CompileStatus::export(&cfg).unwrap();
        CompiledPayload::export(&cfg).unwrap();
        DiagnosticsPayload::export(&cfg).unwrap();
        StatusPayload::export(&cfg).unwrap();
        OpenedDocument::export(&cfg).unwrap();
        LspStatusPayload::export(&cfg).unwrap();
    }

    #[test]
    fn status_serializes_lowercase() {
        // Matches the frontend's `"compiling" | "success" | ...` union.
        assert_eq!(serde_json::to_string(&CompileStatus::Compiling).unwrap(), "\"compiling\"");
        assert_eq!(serde_json::to_string(&CompileStatus::Success).unwrap(), "\"success\"");
        assert_eq!(serde_json::to_string(&CompileStatus::Error).unwrap(), "\"error\"");
        assert_eq!(serde_json::to_string(&CompileStatus::Idle).unwrap(), "\"idle\"");
    }

    #[test]
    fn compiled_payload_is_camel_case() {
        let payload = CompiledPayload {
            id: DocumentId::new(),
            pages: vec!["<svg/>".to_string()],
            duration_ms: 7,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"durationMs\""), "camelCase field expected: {json}");
        assert!(json.contains("\"pages\""));
        assert!(json.contains("\"id\""));
    }
}
