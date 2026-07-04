//! Document outline extraction (§Outline view).
//!
//! Queries the [`PagedDocument`]'s introspector for `HeadingElem`s (the same
//! mechanism typst's own `outline` element uses — `HeadingElem::ELEM.select()`),
//! resolves each to a source line via [`span_to_line`] (the helper shared with
//! `source_map.rs` / diagnostics), and emits a flat [`Vec<OutlineNode>`] with
//! parent indices. The frontend rebuilds the tree (or just renders an indented
//! flat list) from `level`.
//!
//! ## API notes (typst 0.15)
//!
//! - `doc.introspector()` returns `&Arc<PagedIntrospector>`, which implements
//!   `typst::introspection::Introspector`. Its `query(&Selector)` only handles
//!   `Selector::Elem(..)` — `Selector::can::<T>()` (a `Can` variant) is **not**
//!   matched, so we use `HeadingElem::ELEM.select()` (`Selector::Elem`), which
//!   is exactly what `typst_library::model::outline` does for its default
//!   `target` (`HeadingElem::ELEM.select()`).
//! - Each `Content` is downcast with `to_packed::<HeadingElem>()`. Heading
//!   fields (`level`, `body`, `numbers`, `outlined`) are read directly off the
//!   `Packed<HeadingElem>` (they're plain struct fields). Synthesis has already
//!   run by the time the introspector is built, so `level` is the absolute
//!   post-synthesis value and `numbers` holds the formatted numbering string.

use typst::foundations::{Content, NativeElement, StyleChain};
use typst::introspection::Introspector;
use typst::model::HeadingElem;
use typst_layout::PagedDocument;

use crate::domain::outline::OutlineNode;
use crate::typst_engine::compiler::span_to_line;
use crate::typst_engine::world::EditorWorld;

/// Build the document's heading outline.
///
/// Headings with `outlined: false` are skipped — they're explicitly excluded
/// from auto-generated outlines (and from typst's own `outline` element).
/// Headings whose source span can't be resolved to a line are also skipped
/// (synthesized content with no source location); the panel can't usefully
/// jump to them anyway. The result is in document order; `parent` is filled
/// via a monotonic stack keyed on `level`.
///
/// Returns an empty `Vec` if the document has no outlineable headings — the
/// frontend renders a "No headings" placeholder.
pub fn build_outline(doc: &PagedDocument, world: &EditorWorld) -> Vec<OutlineNode> {
    // Selector for all headings — `Selector::Elem(HeadingElem::ELEM, None)`.
    // The introspector's `query` only matches the `Elem` variant, so the
    // `Selector::can::<T>()` shortcut is *not* usable here. This mirrors
    // typst's own outline default target.
    let selector = HeadingElem::ELEM.select();

    let mut nodes: Vec<OutlineNode> = Vec::new();
    // Monotonic stack of (node_index, level) used to find each heading's
    // parent. Top-level headings (no shallower ancestor on the stack) get
    // `parent = None`.
    let mut stack: Vec<(usize, u32)> = Vec::new();

    for content in doc.introspector().query(&selector) {
        let Some(node) = heading_to_node(&content, world) else {
            continue;
        };
        // Pop the stack until we find a strictly shallower ancestor.
        while let Some(&(_, lvl)) = stack.last() {
            if lvl < node.level {
                break;
            }
            stack.pop();
        }
        let parent = stack.last().map(|&(idx, _)| idx as u32);
        let idx = nodes.len();
        nodes.push(OutlineNode {
            parent,
            line: node.line,
            level: node.level,
            title: node.title,
            numbering: node.numbering,
        });
        stack.push((idx, node.level));
    }

    nodes
}

/// Resolved fields for a single outlineable heading, ready to pack into an
/// [`OutlineNode`]. Exists only so the parent-stack logic above stays readable.
struct Resolved {
    line: u32,
    level: u32,
    title: String,
    numbering: Option<String>,
}

/// Convert a heading `Content` into a [`Resolved`] node, or `None` if it should
/// be skipped (not outlined, or no resolvable source line).
fn heading_to_node(content: &Content, world: &EditorWorld) -> Option<Resolved> {
    let heading = content.to_packed::<HeadingElem>()?;

    // Skip headings explicitly excluded from outlines (`#heading(outlined:
    // false)[...]`). `StyleChain::default()` is correct here: synthesis has
    // already resolved the field onto the packed element, and typst's own
    // `Outlinable for Packed<HeadingElem>` reads it the same way.
    if !heading.outlined.get(StyleChain::default()) {
        return None;
    }

    // `level` is synthesized to `Smart::Custom(absolute)` by
    // `HeadingElem::synthesize` (offset + depth). The introspector only sees
    // post-realization content, so `.get()` is always `Custom` here; fall back
    // to `resolve_level` defensively (matches typst's `Outlinable::level`).
    let level = heading
        .level
        .get(StyleChain::default())
        .map(|nz| nz.get() as u32)
        .unwrap_or_else(|| heading.resolve_level(StyleChain::default()).get() as u32);

    let title = heading.body.plain_text().to_string();

    // `numbers` is a synthesized `EcoString` (the macro makes synthesized
    // fields `Option<T>`). It's set to `Some` during `HeadingElem::synthesize`
    // only when `numbering` is `Some`. `None` ⇔ unnumbered; an empty string
    // (defensive) is also treated as unnumbered.
    let numbering = heading.numbers.as_ref().filter(|s| !s.is_empty()).map(|s| s.to_string());

    let line = span_to_line(content.span(), world)?;

    Some(Resolved {
        line,
        level,
        title,
        numbering,
    })
}

#[cfg(test)]
mod tests {
    //! Mirrors the `source_map.rs` test harness: an embedded-only `EditorWorld`
    //! compiled end-to-end, so `build_outline` exercises the real introspector.

    use super::*;
    use crate::typst_engine::font_loader::SystemFontLoader;

    fn world(text: &str) -> EditorWorld {
        EditorWorld::with_font_loader(text, SystemFontLoader::embedded_only())
    }

    #[test]
    fn extracts_heading_tree_in_document_order() {
        let src = "#set heading(numbering: \"1.\")\n\n= Intro\n\n== Setup\n\n=== Detail\n\n= Methods";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.expect("doc on success");
        let outline = build_outline(&doc, &w);

        let levels: Vec<u32> = outline.iter().map(|n| n.level).collect();
        assert_eq!(levels, vec![1, 2, 3, 1], "levels in document order");

        let titles: Vec<&str> = outline.iter().map(|n| n.title.as_str()).collect();
        assert_eq!(titles, vec!["Intro", "Setup", "Detail", "Methods"]);
    }

    #[test]
    fn fills_parent_indices() {
        let src = "#set heading(numbering: \"1.\")\n\n= A\n\n== B\n\n=== C\n\n= D";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.unwrap();
        let outline = build_outline(&doc, &w);

        // A(0, lvl1) -> parent None
        // B(1, lvl2) -> parent 0
        // C(2, lvl3) -> parent 1
        // D(3, lvl1) -> parent None
        assert_eq!(outline[0].parent, None);
        assert_eq!(outline[1].parent, Some(0));
        assert_eq!(outline[2].parent, Some(1));
        assert_eq!(outline[3].parent, None);
    }

    #[test]
    fn numbering_string_is_present_when_numbered() {
        let src = "#set heading(numbering: \"1.\")\n\n= Intro";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.unwrap();
        let outline = build_outline(&doc, &w);
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].numbering.as_deref(), Some("1"));
    }

    #[test]
    fn numbering_is_none_when_unnumbered() {
        // No `set heading(numbering: ...)` ⇒ headings are unnumbered.
        let src = "= Intro";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.unwrap();
        let outline = build_outline(&doc, &w);
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].numbering, None);
    }

    #[test]
    fn skips_headings_marked_not_outlined() {
        let src = "= Kept\n\n#heading(outlined: false)[Skipped]\n\n= Also kept";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.unwrap();
        let outline = build_outline(&doc, &w);
        let titles: Vec<&str> = outline.iter().map(|n| n.title.as_str()).collect();
        assert!(titles.contains(&"Kept"));
        assert!(titles.contains(&"Also kept"));
        assert!(
            !titles.contains(&"Skipped"),
            "outlined:false heading must be excluded: {titles:?}"
        );
    }

    #[test]
    fn empty_document_yields_no_headings() {
        let w = world("#set page(width: 10cm)\n\nJust body text, no headings.");
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.unwrap();
        let outline = build_outline(&doc, &w);
        assert!(outline.is_empty(), "expected no headings, got {outline:?}");
    }

    #[test]
    fn outline_lines_match_source_lines() {
        // Line 3: `= A`, line 5: `== B`.
        let src = "#set page(width: 10cm)\n\n= A\n\n== B";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.unwrap();
        let outline = build_outline(&doc, &w);
        let lines: Vec<u32> = outline.iter().map(|n| n.line).collect();
        assert!(lines.contains(&3), "heading A on line 3: {lines:?}");
        assert!(lines.contains(&5), "heading B on line 5: {lines:?}");
    }
}
