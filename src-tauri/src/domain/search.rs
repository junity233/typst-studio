//! Cross-file search domain types (§Search view).
//!
//! Pure data: a [`SearchQuery`] request and a [`SearchHit`] result. The actual
//! file-walking + matching lives in [`crate::fs::search`]; this module is just
//! the wire shape shared by the IPC layer and the search engine.

use crate::domain::document::DocumentId;
use serde::{Deserialize, Serialize};

/// Cross-file search request (§Search view).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Optional include glob, e.g. "*.typ". None = all non-ignored files.
    #[serde(default)]
    pub include_glob: Option<String>,
    /// Per-file hit cap (explosion guard).
    #[serde(default = "default_max_per_file")]
    pub max_per_file: usize,
    /// Total hit cap.
    #[serde(default = "default_max_total")]
    pub max_total: usize,
}

fn default_max_per_file() -> usize {
    200
}
fn default_max_total() -> usize {
    2000
}

/// One search hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct SearchHit {
    /// Path relative to workspace root (forward-slash separators).
    pub relative: String,
    /// 1-indexed source line.
    pub line: u32,
    /// 1-indexed column (in Unicode scalar values).
    pub column: u32,
    /// The full line text (truncated for display if very long).
    pub line_text: String,
    /// Char offset of the match start within line_text.
    pub match_start: u32,
    /// Char offset of the match end within line_text.
    pub match_end: u32,
}

/// Cross-file replace request (§Search view → Replace). Pairs a search query
/// with a replacement string plus a few replace-specific options.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ReplaceRequest {
    /// The search query that locates the matches to replace.
    pub query: SearchQuery,
    /// Replacement text. Empty = delete the match. For `is_regex`, `$1`/`$name`
    /// capture-group interpolation is supported (via `regex::replace_all`).
    pub replacement: String,
    /// When true, the replacement is cased to mirror the matched text (literal
    /// mode only): `World` + `earth` → `Earth`, `WORLD` + `earth` → `EARTH`.
    /// Ignored for regex mode.
    #[serde(default)]
    pub preserve_case: bool,
    /// When set, only the single match at this exact source location is
    /// replaced; every other match is left untouched. Drives the per-hit
    /// "Replace" button (which targets one specific hit).
    #[serde(default)]
    pub target: Option<TargetRef>,
}

/// Pinpoints a single match in a single file, used by `ReplaceRequest::target`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct TargetRef {
    /// Path relative to workspace root (forward-slash separators).
    pub relative: String,
    /// 1-indexed source line.
    pub line: u32,
    /// 1-indexed column (in Unicode scalar values).
    pub column: u32,
}

/// Result of a replace-in-files run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ReplaceOutcome {
    /// Number of not-currently-open files written directly to disk.
    pub closed_files_written: u32,
    /// Open documents whose in-memory buffer was updated. The frontend mirrors
    /// each into Monaco via a "controlled replace" (see SearchPanel handshake)
    /// — the buffer must NOT be re-synced via `update_text` from the JS side,
    /// or the revision will desync and the user's next keystroke is dropped.
    pub open_docs: Vec<OpenDocReplacement>,
}

/// One open document whose buffer was replaced. Carries the new content + the
/// backend-allocated revision so the frontend can sync Monaco and the document
/// store in one atomic step.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct OpenDocReplacement {
    #[cfg_attr(feature = "export-types", ts(type = "string"))]
    pub id: DocumentId,
    pub new_content: String,
    /// Backend-allocated revision. `u64` maps to `bigint` by default in ts-rs,
    /// but Tauri serializes it as a JSON number — override to match the wire
    /// format (same as `DocumentMeta::revision`).
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub new_revision: u64,
    /// Absolute path (stringified) — informational; the frontend keys off `id`.
    pub path: String,
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        super::SearchQuery::export(&cfg).unwrap();
        super::SearchHit::export(&cfg).unwrap();
        super::ReplaceRequest::export(&cfg).unwrap();
        super::TargetRef::export(&cfg).unwrap();
        super::ReplaceOutcome::export(&cfg).unwrap();
        super::OpenDocReplacement::export(&cfg).unwrap();
    }
}
