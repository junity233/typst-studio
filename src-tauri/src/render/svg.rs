//! `SvgRenderer` — full-page SVG preview via the `typst-svg` crate.
//!
//! Produces one self-contained SVG string per page of a compiled
//! [`PagedDocument`]. This is the format used for the live editor preview.

use typst_layout::PagedDocument;
use typst_svg::{SvgOptions, svg};

use super::pipeline::{RenderError, RenderPipeline};

/// Renders a Typst document into one SVG string per page.
pub struct SvgRenderer;

impl SvgRenderer {
    /// Create a new renderer with default (compact) SVG options.
    pub fn new() -> Self {
        Self
    }

    /// Render a single page by 0-based index, if present.
    pub fn render_single(&self, doc: &PagedDocument, page_idx: usize) -> Option<String> {
        let opts = SvgOptions::default();
        doc.pages().get(page_idx).map(|page| svg(page, &opts))
    }
}

impl Default for SvgRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderPipeline for SvgRenderer {
    type Output = Vec<String>;

    fn render(&self, doc: &PagedDocument) -> Result<Self::Output, RenderError> {
        let opts = SvgOptions::default();
        // `typst_svg::svg` is infallible (returns `String`), so SVG rendering
        // can never fail — wrap in `Ok` to satisfy the fallible trait.
        Ok(doc.pages().iter().map(|page| svg(page, &opts)).collect())
    }
}

#[cfg(test)]
mod tests {
    //! Strategy: **Option A** (runtime test). We compile a one-word source via
    //! the shared [`crate::render::test_world::MiniWorld`] and feed the
    //! resulting `PagedDocument` to the renderer. This exercises the real
    //! `typst_svg::svg` path end-to-end.

    use super::*;
    use crate::render::test_world::MiniWorld;

    #[test]
    fn svg_renderer_produces_one_svg_per_page() {
        let world = MiniWorld::new("Hello");
        let doc = world.compile().expect("compile failed");
        let pages = SvgRenderer.render(&doc).expect("svg render is infallible");

        assert!(!pages.is_empty(), "expected at least one page");
        for (i, svg) in pages.iter().enumerate() {
            assert!(
                svg.starts_with("<svg"),
                "page {i} should start with an <svg> tag, got: {}",
                &svg[..svg.len().min(40)]
            );
        }
    }

    #[test]
    fn render_single_returns_none_for_out_of_range() {
        let world = MiniWorld::new("Hi");
        let doc = world.compile().expect("compile failed");
        let n = doc.pages().len();
        assert!(SvgRenderer.render_single(&doc, 0).is_some());
        assert!(SvgRenderer.render_single(&doc, n).is_none());
    }
}
