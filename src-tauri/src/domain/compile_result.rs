//! `CompileOutcome` — IPC-friendly result of a compile invocation.
//!
//! `typst::Document` itself is not serializable, so the IPC layer emits this
//! summary instead (errors + timing); rendered artifacts (SVG/PDF) flow
//! through separate channels.

use crate::domain::diagnostics::Diagnostic;

/// Result of compiling a single document.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CompileOutcome {
    /// `true` when compilation produced output with no errors.
    pub success: bool,
    /// Wall-clock compile duration in milliseconds.
    pub duration_ms: u64,
    /// Errors encountered (empty on success).
    pub errors: Vec<Diagnostic>,
}

impl CompileOutcome {
    /// Successful compile.
    pub fn ok(duration_ms: u64) -> Self {
        Self {
            success: true,
            duration_ms,
            errors: Vec::new(),
        }
    }

    /// Failed compile (carries the list of error diagnostics).
    pub fn fail(errors: Vec<Diagnostic>, duration_ms: u64) -> Self {
        Self {
            success: false,
            duration_ms,
            errors,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::diagnostics::{Range, Severity};

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        CompileOutcome::export(&cfg).unwrap();
    }

    #[test]
    fn smoke() {
        let ok = CompileOutcome::ok(42);
        assert!(ok.success);
        assert_eq!(ok.duration_ms, 42);
        assert!(ok.errors.is_empty());

        let diag = Diagnostic::new(
            Severity::Error,
            Range {
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 2,
            },
            "err",
        );
        let fail = CompileOutcome::fail(vec![diag.clone()], 7);
        assert!(!fail.success);
        assert_eq!(fail.errors.len(), 1);
        assert_eq!(fail.errors[0].severity, Severity::Error);

        // JSON round-trip should preserve the success flag.
        let json = serde_json::to_string(&fail).unwrap();
        assert!(json.contains("\"success\":false"));
        let back: CompileOutcome = serde_json::from_str(&json).unwrap();
        assert!(!back.success);
    }
}
