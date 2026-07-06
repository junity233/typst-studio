//! Cross-file search domain types (§Search view).
//!
//! Pure data: a [`SearchQuery`] request and a [`SearchHit`] result. The actual
//! file-walking + matching lives in [`crate::fs::search`]; this module is just
//! the wire shape shared by the IPC layer and the search engine.

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

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        super::SearchQuery::export(&cfg).unwrap();
        super::SearchHit::export(&cfg).unwrap();
    }
}
