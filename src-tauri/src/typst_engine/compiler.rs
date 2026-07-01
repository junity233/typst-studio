//! Compiler orchestration — runs [`typst::compile`] against an [`EditorWorld`]
//! and translates the result into our IPC-friendly domain types.
//!
//! ## Diagnostic conversion
//!
//! [`typst::diag::SourceDiagnostic`] carries a [`DiagSpan`] which may be a raw
//! byte range, a numbered source span, or detached. Resolving it to the
//! 1-indexed line/column [`Range`] our editor (Monaco) expects requires the
//! source *text*, so the conversion is a free function
//! [`convert_diagnostic`] that takes the main [`Source`] as context, rather
//! than a plain `From` impl (which would have no way to resolve spans). This
//! also keeps the `domain` layer free of any `typst` dependency.

use std::ops::Range as ByteRange;
use std::time::Instant;

use typst::diag::{Severity as TypstSeverity, SourceDiagnostic};
use typst::syntax::{DiagSpanKind, Source};
use typst_layout::PagedDocument;

use crate::domain::compile_result::CompileOutcome;
use crate::domain::diagnostics::{Diagnostic, Range, Severity};

use super::world::EditorWorld;

/// Compile the world, returning both the IPC outcome and — on success — the
/// renderable [`PagedDocument`].
///
/// Returns a tuple so Phase 4's scheduler can hand the document straight to the
/// render layer (`typst-svg` / `typst-pdf` / `typst-render`) without
/// recompiling. [`CompileOutcome`] itself is not serializable-as-a-document, so
/// the `PagedDocument` travels out-of-band.
pub fn compile(world: &EditorWorld) -> (CompileOutcome, Option<PagedDocument>) {
    let start = Instant::now();

    // `typst::compile` returns `Warned<SourceResult<T>>`; `.output` is the
    // `Result<PagedDocument, EcoVec<SourceDiagnostic>>`. Each call to
    // `typst::compile` performs a fresh `world.track()`, so the world's current
    // source text is read on every invocation (see `world.rs` docs).
    let warned = typst::compile::<PagedDocument>(world);
    let duration_ms = start.elapsed().as_millis() as u64;

    match warned.output {
        Ok(doc) => (CompileOutcome::ok(duration_ms), Some(doc)),
        Err(errors) => {
            // All spans originate in the main file (no `#include` in MVP), so
            // resolving against the main source is correct.
            let source = world.main_source();
            let diagnostics: Vec<Diagnostic> =
                errors.iter().map(|d| convert_diagnostic(d, &source)).collect();
            (CompileOutcome::fail(diagnostics, duration_ms), None)
        }
    }
}

/// Translate a single Typst [`SourceDiagnostic`] into our domain [`Diagnostic`].
///
/// Span resolution maps byte offsets to 1-indexed (line, column) pairs via the
/// source's line index. Detached spans collapse to position (1, 1). The column
/// counts Unicode scalar values (chars), matching `typst::syntax::Lines`; the
/// IPC layer may re-encode to UTF-16 for Monaco if needed.
pub fn convert_diagnostic(d: &SourceDiagnostic, source: &Source) -> Diagnostic {
    let severity = match d.severity {
        TypstSeverity::Error => Severity::Error,
        TypstSeverity::Warning => Severity::Warning,
    };

    let range = match d.span.get() {
        DiagSpanKind::Range { range, .. } => byte_range_to_range(source, range),
        DiagSpanKind::Number { num, sub_range, .. } => {
            match source.range(num, sub_range) {
                Some(bytes) => byte_range_to_range(source, bytes),
                None => default_range(),
            }
        }
        DiagSpanKind::Detached => default_range(),
    };

    Diagnostic {
        severity,
        range,
        message: d.message.to_string(),
        // typst 0.15's `SourceDiagnostic` carries no error code.
        code: None,
    }
}

/// Convert a 0-indexed byte range into a 1-indexed `Range`.
fn byte_range_to_range(source: &Source, bytes: ByteRange<usize>) -> Range {
    let lines = source.lines();
    let (sl, sc) = lines
        .byte_to_line_column(bytes.start)
        .unwrap_or((0, 0));
    let (el, ec) = lines.byte_to_line_column(bytes.end).unwrap_or((sl, sc));
    Range {
        start_line: sl + 1,
        start_column: sc + 1,
        end_line: el + 1,
        end_column: ec + 1,
    }
}

/// Fallback range for detached / unresolvable spans.
fn default_range() -> Range {
    Range {
        start_line: 1,
        start_column: 1,
        end_line: 1,
        end_column: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typst_engine::font_loader::SystemFontLoader;

    fn world(text: &str) -> EditorWorld {
        // Embedded-only: fast and deterministic, no system font scan.
        EditorWorld::with_font_loader(text, SystemFontLoader::embedded_only())
    }

    #[test]
    fn compiles_simple_source_to_document() {
        let w = world("#set page(width: 10cm)\n\nHello, Typst!");
        let (outcome, doc) = compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.expect("document should be Some on success");
        assert!(
            doc.pages().len() >= 1,
            "expected at least one page, got {}",
            doc.pages().len()
        );
    }

    #[test]
    fn reports_diagnostics_for_invalid_source() {
        let w = world("#assert(false)\n");
        let (outcome, doc) = compile(&w);
        assert!(!outcome.success, "assert(false) must fail");
        assert!(doc.is_none(), "no document on failure");
        assert!(
            !outcome.errors.is_empty(),
            "at least one diagnostic expected"
        );
        let first = &outcome.errors[0];
        assert_eq!(first.severity, Severity::Error);
        assert!(!first.message.is_empty(), "diagnostic should carry a message");
        assert!(first.code.is_none(), "typst 0.15 has no error code");
    }

    #[test]
    fn diagnostics_carry_1_indexed_range() {
        // Error on the second line: line/col must be 1-indexed (>= 1).
        let w = world("Hello\n#assert(false)\n");
        let (outcome, _) = compile(&w);
        let d = outcome
            .errors
            .first()
            .expect("expected a diagnostic");
        assert!(d.range.start_line >= 1);
        assert!(d.range.start_column >= 1);
        assert!(d.range.end_line >= 1);
        assert!(d.range.end_column >= 1);
    }

    #[test]
    fn caches_survive_across_edits() {
        // Build once, then edit and recompile. The same `EditorWorld` instance
        // is reused so comemo's cross-compile accelerator stays applicable.
        let w = world("#set page(width: 10cm)\n\nHello");
        let (first, _) = compile(&w);
        assert!(first.success);

        w.set_text("#set page(width: 10cm)\n\nHello, world!".to_string());
        let (second, doc) = compile(&w);
        assert!(second.success, "errors: {:?}", second.errors);
        assert_eq!(w.text(), "#set page(width: 10cm)\n\nHello, world!");
        assert!(doc.is_some());
    }

    #[test]
    fn empty_source_compiles() {
        let w = world("");
        let (outcome, doc) = compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        // An empty doc still lays out to at least one (blank) page.
        assert!(doc.unwrap().pages().len() >= 1);
    }

    #[test]
    fn convert_diagnostic_handles_detached_span() {
        // A detached span must fall back to (1, 1) without panicking.
        let source = Source::detached("anything");
        let d = SourceDiagnostic::error(typst::syntax::DiagSpan::detached(), "boom");
        let out = convert_diagnostic(&d, &source);
        assert_eq!(out.severity, Severity::Error);
        assert_eq!(out.message, "boom");
        assert_eq!(out.range, default_range());
    }
}
