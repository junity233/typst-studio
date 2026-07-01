//! Compile lifecycle status.
//!
//! Conceptually a domain enum (it describes a compile's state, independent of
//! any transport), it previously lived in `ipc::events`. It was moved here to
//! remove a reverse dependency: `service` referenced `ipc::events::CompileStatus`,
//! which inverted the `service → ipc` layering. Now `ipc::events` re-exports it
//! from here for wire-format continuity.

/// Lifecycle status of a compile, emitted on the `status` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum CompileStatus {
    Idle,
    Compiling,
    Success,
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        CompileStatus::export(&cfg).unwrap();
    }

    #[test]
    fn status_serializes_lowercase() {
        // Matches the frontend's `"compiling" | "success" | ...` union.
        assert_eq!(serde_json::to_string(&CompileStatus::Compiling).unwrap(), "\"compiling\"");
        assert_eq!(serde_json::to_string(&CompileStatus::Success).unwrap(), "\"success\"");
        assert_eq!(serde_json::to_string(&CompileStatus::Error).unwrap(), "\"error\"");
        assert_eq!(serde_json::to_string(&CompileStatus::Idle).unwrap(), "\"idle\"");
    }
}
