//! `ExportService` — renders a tab's compiled document to PDF / PNG / SVG bytes.
//!
//! Export is intentionally separate from live preview: it uses the heavier
//! [`PdfRenderer`] / [`PngRenderer`] pipelines against the document cached on
//! the tab by [`EditorService`], so it never triggers a recompile. This service
//! only does the render (CPU-bound); the IPC command layer handles disk writes
//! (async, off the main thread).
//!
//! ## Export bound to revision (§9)
//!
//! Every render takes the `revision` the user is looking at and resolves it via
//! [`doc_for_revision`](Self::doc_for_revision): if that revision already
//! compiled successfully, its document is rendered; if it is still mid-compile,
//! we wait (bounded by a timeout) for the compile to land; if it failed, the
//! failure's diagnostics are returned. We NEVER silently fall back to an older
//! revision's document — the export always corresponds to the revision the user
//! sees in the editor.

use std::sync::Arc;
use std::time::{Duration, Instant};

use typst_layout::PagedDocument;

use crate::domain::document::DocumentId;
use crate::error::{AppError, Result};
use crate::render::pdf::PdfRenderer;
use crate::render::pipeline::RenderPipeline;
use crate::render::png::PngRenderer;
use crate::render::svg::SvgRenderer;

use super::editor_service::EditorService;

/// Maximum time [`ExportService`] will wait for a requested revision to finish
/// compiling before giving up (§9). Generous on purpose: a heavy compile can
/// take a couple seconds, and the user explicitly asked to export.
const REVISION_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Poll interval while waiting for a compile to reach the requested revision.
const REVISION_POLL_INTERVAL: Duration = Duration::from_millis(25);

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

    /// Resolve the compiled document for exactly `revision` (§9).
    ///
    /// - If `revision` has already compiled **successfully**, return its
    ///   [`PagedDocument`].
    /// - If `revision` has already compiled and **failed**, return its error
    ///   diagnostics as an [`AppError::Export`] — we never silently render an
    ///   older revision's doc.
    /// - If `revision` has NOT compiled yet (a newer edit is mid-compile, or no
    ///   compile has run), poll until it lands or [`REVISION_WAIT_TIMEOUT`]
    ///   elapses, then re-evaluate. A timeout yields
    ///   [`AppError::Export`].
    ///
    /// Reads the `(last_compiled_revision, success, doc, errors)` snapshot under
    /// the tab lock each poll; the triple is written atomically by
    /// [`EditorService::do_compile_for_tab`].
    fn doc_for_revision(&self, id: DocumentId, revision: u64) -> Result<PagedDocument> {
        let deadline = Instant::now() + REVISION_WAIT_TIMEOUT;
        loop {
            let Some(state) = self.editor.last_compile_state(id) else {
                return Err(AppError::Export(format!("no open document for tab {id}")));
            };
            match state.last_compiled_revision {
                Some(compiled) if compiled == revision => {
                    if state.success {
                        return state.doc.ok_or_else(|| {
                            // success flag set but no doc — defensive; treat as
                            // a missing artifact rather than falling back.
                            AppError::Export(format!(
                                "revision {revision} compiled but produced no document for tab {id}"
                            ))
                        });
                    }
                    // The requested revision FAILED. Surface its diagnostics
                    // (§9) instead of silently using an older doc.
                    let msgs: Vec<String> =
                        state.errors.iter().map(|d| d.message.clone()).collect();
                    return Err(AppError::Export(format!(
                        "revision {revision} failed to compile for tab {id}: {}",
                        msgs.join("; ")
                    )));
                }
                Some(compiled) if compiled > revision => {
                    // A NEWER revision already compiled, meaning the requested
                    // revision was superseded without its own compile landing
                    // (the worker coalesces). Its doc is gone — we cannot render
                    // exactly `revision`. This is a stale-request error, not a
                    // silent older-doc fallback.
                    return Err(AppError::Export(format!(
                        "revision {revision} is stale (tab {id} is at {compiled}); \
                         cannot export a superseded revision"
                    )));
                }
                _ => {
                    // last_compiled_revision < revision (or None): the requested
                    // revision hasn't compiled yet. Wait and re-poll.
                    if Instant::now() >= deadline {
                        return Err(AppError::Export(format!(
                            "timed out waiting for revision {revision} to compile for tab {id}"
                        )));
                    }
                    std::thread::sleep(REVISION_POLL_INTERVAL);
                }
            }
        }
    }

    /// Render the tab's document for `revision` to a single PDF byte buffer.
    fn render_pdf_bytes(&self, id: DocumentId, revision: u64) -> Result<Vec<u8>> {
        let doc = self.doc_for_revision(id, revision)?;
        Ok(self.pdf_renderer.render(&doc))
    }

    /// Render each page to a PNG byte buffer. Returns `(name, bytes)` pairs
    /// where name is `{base_name}-{n}.png`.
    fn render_png_bytes(
        &self,
        id: DocumentId,
        revision: u64,
        base_name: &str,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        let doc = self.doc_for_revision(id, revision)?;
        let pages = self.png_renderer.render(&doc);
        Ok(pages
            .into_iter()
            .enumerate()
            .map(|(i, png)| (format!("{base_name}-{}.png", i + 1), png))
            .collect())
    }

    /// Render each page to an SVG string. Returns `(name, bytes)` pairs where
    /// name is `{base_name}-{n}.svg`.
    fn render_svg_bytes(
        &self,
        id: DocumentId,
        revision: u64,
        base_name: &str,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        let doc = self.doc_for_revision(id, revision)?;
        let pages = self.svg_renderer.render(&doc);
        Ok(pages
            .into_iter()
            .enumerate()
            .map(|(i, svg)| (format!("{base_name}-{}.svg", i + 1), svg.into_bytes()))
            .collect())
    }

    /// Render to PDF bytes for `revision` (§9). Public entry point for the
    /// command layer (which writes to disk asynchronously).
    pub fn render_pdf(&self, id: DocumentId, revision: u64) -> Result<Vec<u8>> {
        self.render_pdf_bytes(id, revision)
    }

    /// Render to PNG bytes for `revision` (§9). Returns `(filename, bytes)` per
    /// page.
    pub fn render_pngs(
        &self,
        id: DocumentId,
        revision: u64,
        base_name: &str,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        self.render_png_bytes(id, revision, base_name)
    }

    /// Render to SVG bytes for `revision` (§9). Returns `(filename, bytes)` per
    /// page.
    pub fn render_svgs(
        &self,
        id: DocumentId,
        revision: u64,
        base_name: &str,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        self.render_svg_bytes(id, revision, base_name)
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
                _: u64,
                _: Vec<String>,
                _: Vec<crate::domain::source_map::LineRect>,
                _: u64,
            ) {
            }
            fn emit_diagnostics(&self, _: DocumentId, _: u64, _: Vec<Diagnostic>) {}
            fn emit_status(
                &self,
                _: DocumentId,
                _: u64,
                _: crate::ipc::events::CompileStatus,
                _: Option<u64>,
            ) {
            }
            fn emit_conflict(
                &self,
                _: DocumentId,
                _: u64,
                _: crate::domain::document::ConflictState,
                _: Option<String>,
            ) {
            }
        }
        Arc::new(EditorService::new(Arc::new(NoopEmitter)))
    }

    fn make_editor_with_tab(
        content: &str,
    ) -> (Arc<EditorService>, Arc<ExportService>, DocumentId, u64) {
        let editor = make_editor();
        let export = Arc::new(ExportService::new(editor.clone()));
        let meta = editor.new_tab(Some(content.into()));
        // Wait for the initial async compile (revision 0) to finish so last_doc
        // is populated AND last_compiled_revision == 0.
        let id = meta.id;
        for _ in 0..80 {
            let done = editor
                .last_compile_state(id)
                .map(|s| s.last_compiled_revision == Some(0))
                .unwrap_or(false);
            if done {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        (editor, export, id, 0)
    }

    #[test]
    fn render_pdf_produces_valid_pdf_bytes() {
        let (_editor, export, id, revision) =
            make_editor_with_tab("#set page(width: 10cm)\n\nExport me");
        let bytes = export.render_pdf(id, revision).unwrap();
        assert!(
            bytes.starts_with(b"%PDF-"),
            "rendered bytes must be a PDF"
        );
    }

    #[test]
    fn render_pngs_produces_valid_png_per_page() {
        let (_editor, export, id, revision) =
            make_editor_with_tab("#set page(width: 10cm)\n\nPage one");
        let pages = export.render_pngs(id, revision, "doc").unwrap();
        assert!(!pages.is_empty(), "at least one PNG expected");
        for (name, bytes) in &pages {
            assert!(name.starts_with("doc-"), "filename prefix: {name}");
            // PNG magic bytes.
            assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        }
    }

    #[test]
    fn render_svgs_produces_svg_per_page() {
        let (_editor, export, id, revision) =
            make_editor_with_tab("#set page(width: 10cm)\n\nVector export");
        let pages = export.render_svgs(id, revision, "doc").unwrap();
        assert!(!pages.is_empty(), "at least one SVG expected");
        for (name, bytes) in &pages {
            assert!(name.starts_with("doc-"), "filename prefix: {name}");
            let text = std::str::from_utf8(bytes).unwrap();
            assert!(text.starts_with("<svg"), "page should be an SVG: {}", &text[..text.len().min(20)]);
        }
    }

    #[test]
    fn render_without_prior_compile_errors() {
        // A tab whose source fails to compile: exporting its (failed) revision
        // must surface an error rather than silently rendering nothing.
        let editor = make_editor();
        let export = ExportService::new(editor.clone());
        let meta = editor.new_tab(Some("#assert(false)\n".into()));
        // Wait for the failed compile (revision 0) to land.
        for _ in 0..80 {
            let done = editor
                .last_compile_state(meta.id)
                .map(|s| s.last_compiled_revision == Some(0))
                .unwrap_or(false);
            if done {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(export.render_pdf(meta.id, 0).is_err());
    }

    // --- export bound to revision (§9) ---------------------------------------

    /// Wait until the tab's `last_compiled_revision` reaches `revision`.
    fn wait_for_revision(editor: &EditorService, id: DocumentId, revision: u64) {
        for _ in 0..120 {
            let done = editor
                .last_compile_state(id)
                .map(|s| s.last_compiled_revision == Some(revision))
                .unwrap_or(false);
            if done {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("revision {revision} never compiled for {id}");
    }

    #[test]
    fn export_renders_the_doc_matching_the_requested_revision() {
        // Edit the tab once (revision 1) and export revision 1. The rendered
        // PDF must correspond to the edited content — and revision 1's doc,
        // not (say) revision 0's.
        let (editor, export, id, _rev0) =
            make_editor_with_tab("#set page(width: 10cm)\n\nFirst");
        // Edit → revision 1, then wait for its compile.
        editor.update_text(id, "#set page(width: 10cm)\n\nSecond".into()).unwrap();
        wait_for_revision(&editor, id, 1);
        let bytes = export.render_pdf(id, 1).expect("revision 1 should export");
        assert!(bytes.starts_with(b"%PDF-"), "export of revision 1 must be a PDF");
        // revision 0 is now superseded (the worker coalesced past it after the
        // edit landed). Exporting it must NOT silently hand back revision 1's
        // doc — it's a stale request.
        let stale = export.render_pdf(id, 0);
        assert!(stale.is_err(), "exporting a superseded revision must error");
    }

    #[test]
    fn export_of_a_failed_revision_returns_diagnostics_not_older_doc() {
        // §9: a failing compile must surface its error, never silently fall back
        // to an earlier successful revision's document.
        let (editor, export, id, _rev0) =
            make_editor_with_tab("#set page(width: 10cm)\n\nGood");
        // revision 1 FAILS to compile.
        editor.update_text(id, "#assert(false)\n".into()).unwrap();
        wait_for_revision(&editor, id, 1);
        // Sanity: revision 1 failed.
        let state = editor.last_compile_state(id).unwrap();
        assert_eq!(state.last_compiled_revision, Some(1));
        assert!(!state.success, "revision 1 must have failed");

        let err = export
            .render_pdf(id, 1)
            .err()
            .expect("export of a failed revision must error");
        let msg = err.to_string();
        assert!(
            msg.contains("failed to compile") || msg.contains("assert"),
            "error should carry the failure context, got: {msg}"
        );
    }

    #[test]
    fn export_of_not_yet_compiled_revision_waits_then_succeeds() {
        // Trigger an edit and immediately export the new revision: the export
        // should WAIT for that revision to compile, then succeed. (We can't
        // easily force a slow compile, so this mainly exercises the wait loop
        // on a revision that lands shortly after the call.)
        let (editor, export, id, _rev0) =
            make_editor_with_tab("#set page(width: 10cm)\n\nA");
        editor.update_text(id, "#set page(width: 10cm)\n\nB".into()).unwrap();
        // Don't pre-wait — call export right away; doc_for_revision polls.
        let bytes = export.render_pdf(id, 1).expect("should wait then render revision 1");
        assert!(bytes.starts_with(b"%PDF-"));
        // Confirm the wait actually landed on revision 1.
        assert_eq!(
            editor.last_compile_state(id).unwrap().last_compiled_revision,
            Some(1)
        );
    }

    #[test]
    fn doc_for_revision_errors_for_unknown_tab() {
        let editor = make_editor();
        let export = ExportService::new(editor.clone());
        let bogus = DocumentId::new();
        let err = export.render_pdf(bogus, 0).err().expect("unknown tab must error");
        assert!(err.to_string().contains("no open document"));
    }

    #[test]
    fn doc_for_revision_times_out_for_a_revision_that_never_compiles() {
        // Request a revision far in the future that no edit will ever produce.
        // doc_for_revision must give up after the timeout rather than hang.
        let (_editor, export, id, _rev0) =
            make_editor_with_tab("#set page(width: 10cm)\n\nx");
        let start = std::time::Instant::now();
        let err = export
            .render_pdf(id, 9_999)
            .err()
            .expect("an unreachable revision must time out");
        let elapsed = start.elapsed();
        assert!(err.to_string().contains("timed out"), "got: {err}");
        // Sanity: it actually waited ~the timeout, not returned instantly.
        assert!(
            elapsed >= Duration::from_secs(9),
            "should have waited near the timeout, elapsed={elapsed:?}"
        );
    }
}
