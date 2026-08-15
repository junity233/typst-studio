//! `PngRenderer` — per-page PNG export via the `typst-render` crate.
//!
//! Rasterises each page of a [`PagedDocument`] at a configurable
//! `pixel_per_pt` ratio and encodes the result as PNG bytes.

use typst::utils::Scalar;
use typst_layout::PagedDocument;
use typst_render::{RenderOptions, render};

use super::pipeline::{RenderError, RenderPipeline};

/// Renders a Typst document into one PNG byte buffer per page.
///
/// `pixel_per_pt` controls the raster resolution. `2.0` is a sensible default
/// for retina-class displays; `1.0` maps one pixel per typographic point.
pub struct PngRenderer {
    /// Pixels generated per typographic point.
    pub pixel_per_pt: f64,
}

impl PngRenderer {
    /// Create a new renderer with the given pixel-per-point ratio.
    pub fn new(pixel_per_pt: f64) -> Self {
        Self { pixel_per_pt }
    }
}

impl Default for PngRenderer {
    fn default() -> Self {
        // ~2x scale for crisp retina rendering, matching `typst-render`'s own
        // default `RenderOptions`.
        Self::new(2.0)
    }
}

impl RenderPipeline for PngRenderer {
    type Output = Vec<Vec<u8>>;

    fn render(&self, doc: &PagedDocument) -> Result<Self::Output, RenderError> {
        let opts = RenderOptions {
            pixel_per_pt: Scalar::new(self.pixel_per_pt),
            render_bleed: false,
        };
        // `Pixmap::encode_png` is fallible (encoding / OOM failures). Collect
        // into a `Result<Vec<_>, _>` so the first encoding error short-circuits
        // into a `RenderError` instead of panicking.
        doc.pages()
            .iter()
            .map(|page| {
                let pixmap = render(page, &opts);
                pixmap
                    .encode_png()
                    .map_err(|e| RenderError::new("png", e.to_string()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    //! Strategy: **Option A** (runtime test). See `svg.rs` for rationale.
    use super::*;
    use crate::render::test_world::MiniWorld;

    #[test]
    fn png_renderer_produces_valid_png_per_page() {
        let world = MiniWorld::new("PNG time");
        let doc = world.compile().expect("compile failed");
        let pages = PngRenderer::default()
            .render(&doc)
            .expect("png render should succeed");

        assert!(!pages.is_empty(), "expected at least one page");
        for (i, png) in pages.iter().enumerate() {
            // PNG magic bytes.
            assert!(
                png.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
                "page {i} is not a valid PNG"
            );
            assert!(png.len() > 100, "page {i} PNG suspiciously small");
        }
    }

    #[test]
    fn higher_pixel_per_pt_produces_more_bytes() {
        let world = MiniWorld::new("Scale");
        let doc = world.compile().expect("compile failed");

        let lo = PngRenderer::new(1.0)
            .render(&doc)
            .expect("render lo")
            .into_iter()
            .next()
            .unwrap();
        let hi = PngRenderer::new(3.0)
            .render(&doc)
            .expect("render hi")
            .into_iter()
            .next()
            .unwrap();
        assert!(
            hi.len() > lo.len(),
            "3.0 px/pt ({}) should yield more bytes than 1.0 px/pt ({})",
            hi.len(),
            lo.len()
        );
    }
}
