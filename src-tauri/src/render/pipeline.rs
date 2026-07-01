//! `RenderPipeline` trait — the common interface every renderer implements.
//!
//! A render pipeline turns a compiled Typst [`PagedDocument`] into some output
//! format (SVG strings, PDF bytes, PNG byte buffers, ...).
//!
//! ## Why `typst_layout::PagedDocument`?
//!
//! In typst 0.15 the crate split placed the concrete, renderable document type
//! `PagedDocument` (and its `Page`) in the dedicated `typst-layout` crate. The
//! `typst::model::Document` item that exists in 0.15 is only a *trait*
//! exposing metadata (`info()`); it does not grant access to page frames, so
//! it cannot drive rendering. Every `typst-svg` / `typst-pdf` / `typst-render`
//! entry point takes `&PagedDocument` (or `&Page`) by reference, which is why
//! the trait is defined against that concrete type.

use typst_layout::PagedDocument;

/// A render pipeline turns a compiled Typst document into some output format.
///
/// Implementations live in this module: [`SvgRenderer`](super::svg::SvgRenderer),
/// [`PdfRenderer`](super::pdf::PdfRenderer) and
/// [`PngRenderer`](super::png::PngRenderer).
pub trait RenderPipeline {
    /// The format produced for a single document (e.g. `Vec<String>`, `Vec<u8>`).
    type Output;

    /// Render the whole `doc` into [`Output`](Self::Output).
    fn render(&self, doc: &PagedDocument) -> Self::Output;
}

#[cfg(test)]
mod tests {
    //! Type-level checks only. The trait is exercised end-to-end by the
    //! runtime tests in `svg.rs`, `pdf.rs` and `png.rs`.

    use super::*;
    use crate::render::pdf::PdfRenderer;
    use crate::render::png::PngRenderer;
    use crate::render::svg::SvgRenderer;

    /// Every concrete renderer must implement `RenderPipeline` with the
    /// expected associated `Output` type. This is a pure compile-time check.
    #[test]
    fn all_renderers_implement_the_pipeline() {
        fn assert_pipeline<P: RenderPipeline>(_p: &P) {}

        let svg = SvgRenderer;
        let pdf = PdfRenderer;
        let png = PngRenderer::default();

        assert_pipeline(&svg);
        assert_pipeline(&pdf);
        assert_pipeline(&png);

        // Pin the associated output types so accidental changes are caught.
        // (Aliases avoid a `Vec<Vec<u8>>>` triple-angle-bracket in the bound.)
        type SvgOut = Vec<String>;
        type PdfOut = Vec<u8>;
        type PngOut = Vec<Vec<u8>>;
        fn expect_svg<P: RenderPipeline<Output = SvgOut>>(_p: &P) {}
        fn expect_pdf<P: RenderPipeline<Output = PdfOut>>(_p: &P) {}
        fn expect_png<P: RenderPipeline<Output = PngOut>>(_p: &P) {}

        expect_svg(&svg);
        expect_pdf(&pdf);
        expect_png(&png);
    }

    /// A generic function accepting *any* `RenderPipeline` must type-check.
    /// Uses a phantom (zero-runtime) body so no `Document` is constructed.
    #[test]
    fn trait_is_generic_over_implementors() {
        fn accepts_any_pipeline<P: RenderPipeline>() {
            let _ = std::marker::PhantomData::<P>;
        }
        accepts_any_pipeline::<SvgRenderer>();
        accepts_any_pipeline::<PdfRenderer>();
        accepts_any_pipeline::<PngRenderer>();
    }
}
