//! `PdfRenderer` — PDF export via the `typst-pdf` crate.
//!
//! Produces the raw bytes of a single PDF containing every page of a compiled
//! [`PagedDocument`].

use typst_layout::PagedDocument;
use typst_pdf::{PdfOptions, pdf};

use super::pipeline::{RenderError, RenderPipeline};

/// Renders a Typst document into a single PDF file's raw bytes.
pub struct PdfRenderer;

impl PdfRenderer {
    /// Create a new renderer with default options.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PdfRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderPipeline for PdfRenderer {
    type Output = Vec<u8>;

    fn render(&self, doc: &PagedDocument) -> Result<Self::Output, RenderError> {
        self.render_with_options(doc, &PdfOptions::default())
    }
}

impl PdfRenderer {
    /// Render with explicit options (page ranges / PDF standard / tagging —
    /// driven by the `export.pdf*` settings via
    /// [`pdf_options_from_settings`](super::pdf_options::pdf_options_from_settings)).
    ///
    /// `typst_pdf::pdf` is fallible: font/image/embedding errors surface as
    /// an `EcoVec<SourceDiagnostic>`. Propagate them so the export command
    /// can render an `AppError::Export` dialog instead of panicking through
    /// the async Tauri command (which would tear down the worker task). The
    /// eco vec isn't `Display`, so join the per-diagnostic messages.
    pub fn render_with_options(
        &self,
        doc: &PagedDocument,
        options: &PdfOptions,
    ) -> Result<Vec<u8>, RenderError> {
        pdf(doc, options).map_err(|errs| {
            let msgs: Vec<&str> = errs.iter().map(|d| d.message.as_str()).collect();
            RenderError::new("pdf", msgs.join("; "))
        })
    }
}

#[cfg(test)]
mod tests {
    //! Strategy: **Option A** (runtime test). See `svg.rs` for rationale.
    use super::*;
    use crate::render::test_world::MiniWorld;

    #[test]
    fn pdf_renderer_emits_valid_pdf_header() {
        let world = MiniWorld::new("Hello, PDF!");
        let doc = world.compile().expect("compile failed");
        let bytes = PdfRenderer.render(&doc).expect("pdf render should succeed");

        assert!(!bytes.is_empty(), "PDF bytes should be non-empty");
        // Every PDF file starts with `%PDF-`.
        assert_eq!(&bytes[..5], b"%PDF-", "PDF magic header missing");
    }
}
