//! LaTeX → Typst math conversion command (Insert Formula feature).
//!
//! Thin adapter over the [`tylax`] crate (v0.3.6, `rlib`). The frontend's
//! Formula modal feeds the user's raw LaTeX here, gets back Typst math source
//! plus any conversion warnings, then wraps it in `$ … $` and inserts it at the
//! cursor.
//!
//! Stateless: takes a `String`, returns `Result<LatexConvertResult, AppError>`.
//! Conversion is pure CPU (no I/O, no `AppState`), fast (microseconds for a
//! typical formula), so a synchronous command is fine — matches the shape of
//! other stateless converters here.
//!
//! We call `latex_math_to_typst_with_diagnostics` (the MATH path) so an input
//! like `\frac{a}{b}` converts to `a/b` with NO surrounding Typst preamble.
//! Note the trap: `tylax::latex_to_typst_with_diagnostics` (same name, no
//! `_math_`) routes through the DOCUMENT path and emits `#set page(...)`,
//! `#set heading(...)`, … around the body — wrong for an inline formula. The
//! result type is tylax's `core::latex2typst::ConversionResult` (re-exported as
//! `L2TConversionResult`); we project it into our own serializable
//! [`LatexConvertResult`] to keep the wire shape stable and camelCased
//! independently of tylax's internal naming.

use crate::error::Result;

/// One conversion warning. `kind` is a short stable slug derived from tylax's
/// [`WarningKind`](tylax::WarningKind) `Display` impl (e.g. `"unsupported
/// macro"`, `"parse error"`); `message` is the human-readable detail. The modal
/// surfaces these as a non-blocking hint so the user knows the conversion may be
/// imperfect (e.g. an unknown macro passed through unchanged).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct LatexConvertWarning {
    /// Short stable slug, e.g. `"unsupported macro"`, `"parse error"`.
    pub kind: String,
    /// Human-readable detail (e.g. `"Unknown macro '\foo' passed through unchanged"`).
    pub message: String,
}

/// Result of converting a LaTeX math snippet to Typst math source.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct LatexConvertResult {
    /// The converted Typst math source (without surrounding `$` — the frontend
    /// adds those based on inline/display mode and current math context).
    pub output: String,
    /// Non-fatal conversion warnings (unknown macros, partial expansions, …).
    /// Empty when the conversion was clean.
    pub warnings: Vec<LatexConvertWarning>,
}

/// Convert a LaTeX math snippet to Typst math source.
///
/// Input is raw LaTeX math (no surrounding `$`/`\[...\]`/`\begin{equation}` —
/// just the formula body, e.g. `\frac{a}{b} + \sum_{i=1}^n x_i`). Unknown macros
/// pass through unchanged (tylax's non-strict default), so a conversion never
/// hard-fails; warnings flag anything that may need manual review.
#[tauri::command]
pub fn convert_latex_to_typst(latex: String) -> Result<LatexConvertResult> {
    // IMPORTANT: `latex_math_to_typst_with_diagnostics` (MATH path), NOT the
    // same-named `latex_to_typst_with_diagnostics`. The latter routes through
    // `convert_document_with_diagnostics` and emits a full Typst preamble
    // (`#set page(...)`, `#set heading(...)`, …) around the body — wrong for an
    // inline formula. tylax's conversion is infallible at the type level
    // (returns a plain struct, never `Err`); a panic inside the converter on
    // pathological input propagates as a rejected IPC promise, which is the
    // desired behavior (it indicates a tylax bug worth surfacing).
    let res = tylax::latex_math_to_typst_with_diagnostics(&latex);
    Ok(LatexConvertResult {
        output: res.output,
        warnings: res
            .warnings
            .into_iter()
            .map(|w| LatexConvertWarning {
                kind: w.kind.to_string(),
                message: w.message,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The math path must return the bare converted math body — NO Typst
    /// preamble (`#set page(...)`, `#set heading(...)`, …). This guards against
    /// accidentally switching to `latex_to_typst_with_diagnostics`, which
    /// (despite the name) uses the document path and would pollute an inline
    /// formula with document setup.
    #[test]
    fn math_path_emits_no_preamble() {
        let res = convert_latex_to_typst(r"x^2 + \alpha".to_string()).unwrap();
        assert!(
            !res.output.contains("#set page"),
            "math path leaked a document preamble: {:#?}",
            res.output,
        );
        assert!(
            !res.output.contains("#set heading"),
            "math path leaked a document preamble: {:#?}",
            res.output,
        );
        // The converted math body should reference the converted alpha symbol.
        assert!(
            res.output.contains("alpha"),
            "expected the converted body to contain 'alpha', got: {:#?}",
            res.output,
        );
    }

    /// A simple fraction converts to slash form (tylax's `frac_to_slash`
    /// default) or `frac(...)` — either is acceptable, but it must be a short
    /// math expression, not a document.
    #[test]
    fn frac_converts_to_math() {
        let res = convert_latex_to_typst(r"\frac{a}{b}".to_string()).unwrap();
        assert!(
            res.output.contains('/') || res.output.contains("frac"),
            "expected a fraction conversion, got: {:#?}",
            res.output,
        );
    }
}
