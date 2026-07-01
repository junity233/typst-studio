//! Diagnostics — Typst `SourceDiagnostic` translated to our serializable model.
//!
//! Note: the conversion `From<typst::diag::SourceDiagnostic>` lives in
//! `typst_engine` (Phase 2), which owns the typst dependency details.

/// Severity of a diagnostic message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// A 1-indexed text range (Monaco-friendly). Half-open `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct Range {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

/// A single diagnostic, IPC/serialization-friendly.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct Diagnostic {
    pub severity: Severity,
    pub range: Range,
    pub message: String,
    /// Typst error code, when available.
    pub code: Option<i64>,
}

impl Diagnostic {
    /// Convenience constructor.
    pub fn new(severity: Severity, range: Range, message: impl Into<String>) -> Self {
        Self {
            severity,
            range,
            message: message.into(),
            code: None,
        }
    }
}

// TODO(Phase 2): impl From<typst::diag::SourceDiagnostic> for Diagnostic in
// `typst_engine` (needs `&EngineWorld` to resolve source spans).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        Severity::export(&cfg).unwrap();
        Range::export(&cfg).unwrap();
        Diagnostic::export(&cfg).unwrap();
    }

    #[test]
    fn smoke() {
        let r = Range {
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 5,
        };
        let d = Diagnostic::new(Severity::Error, r, "boom");
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.message, "boom");
        assert!(d.code.is_none());

        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"severity\":\"Error\""));
        assert!(json.contains("\"message\":\"boom\""));
        assert!(json.contains("\"code\":null"));
    }
}
