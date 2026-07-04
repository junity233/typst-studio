//! Document outline — the heading tree (§Outline view).
//!
//! A flat `Vec<OutlineNode>` shipped as part of the `compiled` event payload
//! (same revision as `line_map` and `pages`). Each node carries its absolute
//! heading level and the index of its parent, so the frontend can rebuild the
//! tree with a monotonic stack — or just render it as an indented flat list.
//!
//! Mirrors the wire-format conventions of [`crate::domain::source_map::LineRect`]
//! (`#[serde(rename_all = "camelCase")]`).

/// One node in the document outline (heading tree) — §Outline view.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct OutlineNode {
    /// 1-indexed source line (matches `LineRect.line` / Diagnostic range).
    pub line: u32,
    /// Absolute heading level (1 = H1). Post-synthesis (`offset + depth`
    /// applied by typst's `HeadingElem::synthesize`).
    pub level: u32,
    /// Plain-text title (`HeadingElem.body`'s `plain_text`).
    pub title: String,
    /// Numbering text (e.g. `"1.2.3"`), `None` if the heading is unnumbered.
    pub numbering: Option<String>,
    /// Index into the same `Vec` of this node's parent; `None` for top-level.
    /// Frontend can also rebuild the tree from `level` via a monotonic stack,
    /// but the explicit parent index is more robust.
    pub parent: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        OutlineNode::export(&cfg).unwrap();
    }

    #[test]
    fn camel_case_wire_fields() {
        let node = OutlineNode {
            line: 5,
            level: 2,
            title: "Methods".to_string(),
            numbering: Some("1.2".to_string()),
            parent: Some(0),
        };
        let json = serde_json::to_string(&node).unwrap();
        // All single-word fields — wire name == Rust field name.
        assert!(json.contains("\"line\":5"));
        assert!(json.contains("\"level\":2"));
        assert!(json.contains("\"title\":\"Methods\""));
        assert!(json.contains("\"numbering\":\"1.2\""));
        assert!(json.contains("\"parent\":0"));
    }

    #[test]
    fn null_numbering_and_parent_serialize() {
        let node = OutlineNode {
            line: 1,
            level: 1,
            title: "Intro".to_string(),
            numbering: None,
            parent: None,
        };
        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"numbering\":null"));
        assert!(json.contains("\"parent\":null"));
    }
}
