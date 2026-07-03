//! `ExportService` — renders a tab's last compiled document to PDF / PNG bytes.
//!
//! Export is intentionally separate from live preview: it uses the heavier
//! [`PdfRenderer`] / [`PngRenderer`] pipelines against the document cached on
//! the tab by [`EditorService`], so it never triggers a recompile. This service
//! only does the render (CPU-bound); the IPC command layer handles disk writes
//! (async, off the main thread).

use std::sync::Arc;

use crate::domain::document::DocumentId;
use crate::error::{AppError, Result};
use crate::render::pdf::PdfRenderer;
use crate::render::pipeline::RenderPipeline;
use crate::render::png::PngRenderer;
use crate::render::svg::SvgRenderer;

use super::editor_service::EditorService;

/// Renders compiled documents to PDF / PNG / SVG bytes.
pub struct ExportService {
    editor: Arc<EditorService>,
    pdf_renderer: PdfRenderer,
    png_renderer: PngRenderer,
    svg_renderer: SvgRenderer,
}

impl ExportService {
    /// Construct with a handle to the editor (for document access) and fresh
    /// renderers.
    pub fn new(editor: Arc<EditorService>) -> Self {
        Self {
            editor,
            pdf_renderer: PdfRenderer::new(),
            png_renderer: PngRenderer::default(),
            svg_renderer: SvgRenderer::new(),
        }
    }

    /// Render the tab's last compiled document to a single PDF byte buffer.
    fn render_pdf_bytes(&self, id: DocumentId) -> Result<Vec<u8>> {
        let doc = self
            .editor
            .last_doc(id)
            .ok_or_else(|| AppError::Export(format!("no compiled document for tab {id}")))?;
        Ok(self.pdf_renderer.render(&doc))
    }

    /// Render each page to a PNG byte buffer. Returns `(name, bytes)` pairs
    /// where name is `{base_name}-{n}.png`.
    fn render_png_bytes(&self, id: DocumentId, base_name: &str) -> Result<Vec<(String, Vec<u8>)>> {
        let doc = self
            .editor
            .last_doc(id)
            .ok_or_else(|| AppError::Export(format!("no compiled document for tab {id}")))?;
        let pages = self.png_renderer.render(&doc);
        Ok(pages
            .into_iter()
            .enumerate()
            .map(|(i, png)| (format!("{base_name}-{}.png", i + 1), png))
            .collect())
    }

    /// Render each page to an SVG string. Returns `(name, bytes)` pairs where
    /// name is `{base_name}-{n}.svg`.
    fn render_svg_bytes(&self, id: DocumentId, base_name: &str) -> Result<Vec<(String, Vec<u8>)>> {
        let doc = self
            .editor
            .last_doc(id)
            .ok_or_else(|| AppError::Export(format!("no compiled document for tab {id}")))?;
        let pages = self.svg_renderer.render(&doc);
        Ok(pages
            .into_iter()
            .enumerate()
            .map(|(i, svg)| (format!("{base_name}-{}.svg", i + 1), svg.into_bytes()))
            .collect())
    }

    /// Render to PDF bytes. Public entry point for the command layer (which
    /// writes to disk asynchronously).
    pub fn render_pdf(&self, id: DocumentId) -> Result<Vec<u8>> {
        self.render_pdf_bytes(id)
    }

    /// Render to PNG bytes. Returns `(filename, bytes)` per page.
    pub fn render_pngs(&self, id: DocumentId, base_name: &str) -> Result<Vec<(String, Vec<u8>)>> {
        self.render_png_bytes(id, base_name)
    }

    /// Render to SVG bytes. Returns `(filename, bytes)` per page.
    pub fn render_svgs(&self, id: DocumentId, base_name: &str) -> Result<Vec<(String, Vec<u8>)>> {
        self.render_svg_bytes(id, base_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::diagnostics::Diagnostic;

    fn make_editor() -> Arc<EditorService> {
        struct NoopEmitter;
        impl crate::service::editor_service::Emitter for NoopEmitter {
            fn emit_compiled(
                &self,
                _: DocumentId,
                _: Vec<String>,
                _: Vec<crate::domain::source_map::LineRect>,
                _: u64,
            ) {
            }
            fn emit_diagnostics(&self, _: DocumentId, _: Vec<Diagnostic>) {}
            fn emit_status(&self, _: DocumentId, _: crate::ipc::events::CompileStatus, _: Option<u64>) {}
        }
        Arc::new(EditorService::new(Arc::new(NoopEmitter)))
    }

    fn make_editor_with_tab(content: &str) -> (Arc<EditorService>, Arc<ExportService>, DocumentId) {
        let editor = make_editor();
        let export = Arc::new(ExportService::new(editor.clone()));
        let meta = editor.new_tab(Some(content.into()));
        // Wait for the initial async compile to finish so last_doc is populated.
        let id = meta.id;
        for _ in 0..40 {
            if editor.last_doc(id).is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        (editor, export, id)
    }

    #[test]
    fn render_pdf_produces_valid_pdf_bytes() {
        let (_editor, export, id) =
            make_editor_with_tab("#set page(width: 10cm)\n\nExport me");
        let bytes = export.render_pdf(id).unwrap();
        assert!(
            bytes.starts_with(b"%PDF-"),
            "rendered bytes must be a PDF"
        );
    }

    #[test]
    fn render_pngs_produces_valid_png_per_page() {
        let (_editor, export, id) =
            make_editor_with_tab("#set page(width: 10cm)\n\nPage one");
        let pages = export.render_pngs(id, "doc").unwrap();
        assert!(!pages.is_empty(), "at least one PNG expected");
        for (name, bytes) in &pages {
            assert!(name.starts_with("doc-"), "filename prefix: {name}");
            // PNG magic bytes.
            assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        }
    }

    #[test]
    fn render_svgs_produces_svg_per_page() {
        let (_editor, export, id) =
            make_editor_with_tab("#set page(width: 10cm)\n\nVector export");
        let pages = export.render_svgs(id, "doc").unwrap();
        assert!(!pages.is_empty(), "at least one SVG expected");
        for (name, bytes) in &pages {
            assert!(name.starts_with("doc-"), "filename prefix: {name}");
            let text = std::str::from_utf8(bytes).unwrap();
            assert!(text.starts_with("<svg"), "page should be an SVG: {}", &text[..text.len().min(20)]);
        }
    }

    #[test]
    fn render_without_prior_compile_errors() {
        // A tab whose source fails to compile has no last_doc → render errors.
        let editor = make_editor();
        let export = ExportService::new(editor.clone());
        let meta = editor.new_tab(Some("#assert(false)\n".into()));
        // Wait briefly for the failed compile.
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(export.render_pdf(meta.id).is_err());
    }
}
