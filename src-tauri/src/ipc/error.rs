//! Structured IPC errors (§5.3).
//!
//! Replaces the old stringly-typed `AppError` serialization with a
//! machine-readable [`IpcError`] object so the frontend can branch on a stable
//! [`ErrorCode`] instead of parsing a localized message string.
//!
//! ## Wire format
//!
//! Every command that returns `Result<T, AppError>` serializes a rejected
//! promise as a JSON **object** (not a string):
//!
//! ```json
//! { "code": "permission_denied", "message": "...", "details": {...}, "recoverable": false }
//! ```
//!
//! `details` is omitted when absent; the frontend's `toIpcError` narrows the
//! rejected `unknown` back to a typed [`IpcError`] (with a fallback for legacy
//! strings / unknown shapes).
//!
//! ## Classification
//!
//! [`AppError`] → [`IpcError`] mapping is intentionally best-effort: typed
//! variants (`Io`, `NotFound`, …) carry enough information to pick a precise
//! code; the generic [`AppError::Code`](crate::error::AppError::Code) escape
//! hatch lets a producer (e.g. [`SaveCoordinator`]) surface a save-specific code
//! that has no dedicated enum variant.
//!
//! [`SaveCoordinator`]: crate::service::save_coordinator::SaveCoordinator

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// A stable, machine-readable error code (§5.3).
///
/// The frontend branches on this instead of parsing a message string. Serialized
/// as `snake_case` so the wire value (`"permission_denied"`) matches the
/// generated TypeScript literal union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum ErrorCode {
    /// No write permission on the target file/dir.
    PermissionDenied,
    /// The target is read-only (opened read-only or marked so).
    ReadOnly,
    /// The destination disk/volume is out of space.
    DiskFull,
    /// The target file disappeared mid-save (it existed at prepare time).
    TargetMissing,
    /// The target's parent directory does not exist.
    ParentMissing,
    /// A non-file entry (directory) occupies the target path.
    PathOccupied,
    /// The on-disk file changed underneath us (§5.4 conflict) — save blocked.
    ExternalConflict,
    /// A document at the target canonical path is already open (§4.1).
    AlreadyOpen,
    /// The path is malformed / not absolute / rejected by validation.
    InvalidPath,
    /// A transient IO error not covered by a more specific code (worth retrying).
    IoTransient,
    /// The referenced document/resource was not found.
    NotFound,
    /// The caller-supplied input was invalid (not path-related).
    InvalidInput,
    /// Typst compile failed.
    Compile,
    /// Export (PDF/PNG/SVG) failed.
    Export,
    /// The user cancelled the operation (e.g. dismissed a dialog). This is
    /// **not** a failure: the frontend's save-error UI must no-op on this code
    /// (no alert, no failure banner). §5.3 "`Cancelled` 不是错误".
    Cancelled,
    /// Anything not covered above.
    Other,
}

/// Structured IPC error (§5.3: `{ code, message, details?, recoverable }`).
///
/// Serialized as a JSON **object** (not a string) so the frontend can branch on
/// `code`. Field names are `camelCase` to match the generated TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct IpcError {
    /// Stable machine-readable code — branch on this in the frontend.
    pub code: ErrorCode,
    /// Human-readable message (locale-independent, English). Safe to surface.
    pub message: String,
    /// Optional structured details (e.g. `AlreadyOpen` carries the existing id
    /// and path so the caller can focus that view). Omitted when `None`. Typed
    /// as a permissive `unknown` on the wire (shape varies by code).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export-types", ts(type = "unknown | null"))]
    pub details: Option<serde_json::Value>,
    /// Whether the caller can reasonably retry / recover. `false` for hard
    /// failures (permission, not-found); `true` for transient ones (the
    /// frontend may offer a Retry button).
    pub recoverable: bool,
}

impl IpcError {
    /// Build an `IpcError` with no details.
    pub fn new(code: ErrorCode, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
            recoverable,
        }
    }

    /// Attach structured `details` (any JSON value).
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Convenience constructor for a `Cancelled` error (§5.3). `recoverable` is
    /// `false` because there's nothing to retry — the frontend no-ops on this.
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Cancelled, message, false)
    }
}

/// Map a `std::io::Error` to the most specific [`ErrorCode`] + recoverability.
///
/// `PermissionDenied` → a hard failure; `StorageFull`/`QuotaExceeded` → `DiskFull`
/// (recoverable, e.g. free space and retry); everything else → `IoTransient`
/// (recoverable). Some platforms surface disk-full as `Other`, which we still
/// classify as `IoTransient` (the broad bucket).
pub(crate) fn classify_io(e: &std::io::Error) -> (ErrorCode, bool) {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied => (ErrorCode::PermissionDenied, false),
        // StorageFull is stable since 1.57; QuotaExceeded since 1.69. Match by
        // raw kind() as a fallback for older std on platforms that emit it as
        // `Other` (best-effort — covered by tests where determinable).
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => (ErrorCode::DiskFull, true),
        // FileNotFound on the *target* during save would be surprising, but
        // classify it precisely so the UI can show "file vanished".
        ErrorKind::NotFound => (ErrorCode::TargetMissing, true),
        _ => {
            // Best-effort disk-full detection for platforms/std versions that
            // surface ENOSPC as `Other` (macOS does surface StorageFull, so this
            // is mostly belt-and-braces).
            if is_disk_full_message(&e.to_string()) {
                return (ErrorCode::DiskFull, true);
            }
            (ErrorCode::IoTransient, true)
        }
    }
}

/// Heuristic: does `msg` look like a "no space left on device" error?
fn is_disk_full_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("no space left") || lower.contains("disk full")
}

impl From<&AppError> for IpcError {
    fn from(err: &AppError) -> Self {
        match err {
            AppError::Io(e) => {
                let (code, recoverable) = classify_io(e);
                IpcError::new(code, e.to_string(), recoverable)
            }
            AppError::Json(e) => {
                // Serialization errors are programmer bugs — not recoverable.
                IpcError::new(ErrorCode::Other, e.to_string(), false)
            }
            AppError::Compile => IpcError::new(ErrorCode::Compile, "typst compile failed", false),
            AppError::Export(msg) => IpcError::new(ErrorCode::Export, msg.clone(), false),
            AppError::NotFound(s) => IpcError::new(ErrorCode::NotFound, s.clone(), false),
            AppError::InvalidInput(s) => {
                // Path-shaped invalid input gets a more specific code so the UI
                // can prompt for Save As / a corrected path.
                let code = if looks_path_related(s) {
                    ErrorCode::InvalidPath
                } else {
                    ErrorCode::InvalidInput
                };
                IpcError::new(code, s.clone(), false)
            }
            AppError::AlreadyOpen { existing_id, path } => {
                let details = serde_json::json!({
                    "existingId": existing_id.to_string(),
                    "path": path,
                });
                IpcError::new(
                    ErrorCode::AlreadyOpen,
                    format!("document already open: {path}"),
                    true,
                )
                .with_details(details)
            }
            AppError::Other(msg) => {
                // "save cancelled" / "export cancelled" — the IPC layer signals
                // a user cancel via AppError::Other("...cancelled"); surface it
                // as the dedicated Cancelled code so the frontend no-ops.
                if msg.to_ascii_lowercase().contains("cancel") {
                    IpcError::cancelled(msg.clone())
                } else {
                    IpcError::new(ErrorCode::Other, msg.clone(), true)
                }
            }
            // The generic structured escape hatch (used by SaveCoordinator).
            // Round-trip the producer-supplied code/message/recoverable/details
            // as-is so structured fields (e.g. AlreadyOpen's existingId/path
            // carried via details) survive the IPC serialization.
            AppError::Code {
                code,
                message,
                recoverable,
                details,
            } => {
                let mut ipc = IpcError::new(*code, message.clone(), *recoverable);
                if let Some(d) = details {
                    ipc = ipc.with_details(d.clone());
                }
                ipc
            }
        }
    }
}

impl From<AppError> for IpcError {
    /// Owned conversion (convenience for callers that already own the error,
    /// e.g. `SaveCoordinator`). Delegates to the reference impl.
    fn from(err: AppError) -> Self {
        IpcError::from(&err)
    }
}

/// Heuristic: does the message look like it's about a path (vs. generic input)?
fn looks_path_related(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.contains("path")
        || lower.contains("file")
        || lower.contains("directory")
        || lower.contains("untitled")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_permission_denied_maps_to_permission_denied() {
        let e = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let ipc: IpcError = AppError::Io(e).into();
        assert_eq!(ipc.code, ErrorCode::PermissionDenied);
        assert!(!ipc.recoverable, "permission errors are not recoverable");
    }

    #[test]
    fn io_storage_full_maps_to_disk_full() {
        let e = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let ipc: IpcError = AppError::Io(e).into();
        assert_eq!(ipc.code, ErrorCode::DiskFull);
        assert!(ipc.recoverable);
    }

    #[test]
    fn io_not_found_maps_to_target_missing() {
        let e = std::io::Error::from(std::io::ErrorKind::NotFound);
        let ipc: IpcError = AppError::Io(e).into();
        assert_eq!(ipc.code, ErrorCode::TargetMissing);
        assert!(ipc.recoverable);
    }

    #[test]
    fn io_other_maps_to_transient() {
        let e = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        let ipc: IpcError = AppError::Io(e).into();
        assert_eq!(ipc.code, ErrorCode::IoTransient);
        assert!(ipc.recoverable);
    }

    #[test]
    fn io_other_disk_full_message_is_detected() {
        // Some platforms surface ENOSPC as Other("...No space left..."); the
        // heuristic should still classify it as DiskFull.
        let e = std::io::Error::new(std::io::ErrorKind::Other, "No space left on device");
        let ipc: IpcError = AppError::Io(e).into();
        assert_eq!(ipc.code, ErrorCode::DiskFull);
    }

    #[test]
    fn already_open_carries_existing_id_and_path() {
        let id = crate::domain::document::DocumentId::new();
        let path = "/tmp/already.typ".to_string();
        let ipc: IpcError = AppError::AlreadyOpen {
            existing_id: id,
            path: path.clone(),
        }
        .into();
        assert_eq!(ipc.code, ErrorCode::AlreadyOpen);
        assert!(ipc.recoverable, "AlreadyOpen is recoverable (focus the view)");
        let details = ipc.details.expect("details present");
        assert_eq!(details["existingId"], id.to_string());
        assert_eq!(details["path"], path);
    }

    #[test]
    fn not_found_is_not_recoverable() {
        let ipc: IpcError = AppError::NotFound("doc".into()).into();
        assert_eq!(ipc.code, ErrorCode::NotFound);
        assert!(!ipc.recoverable);
    }

    #[test]
    fn invalid_input_path_related_is_invalid_path() {
        let ipc: IpcError = AppError::InvalidInput("tab has no on-disk path".into()).into();
        assert_eq!(ipc.code, ErrorCode::InvalidPath);
    }

    #[test]
    fn invalid_input_generic_stays_invalid_input() {
        let ipc: IpcError = AppError::InvalidInput("revision must be >= 0".into()).into();
        assert_eq!(ipc.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn other_cancel_is_classified_as_cancelled() {
        let ipc: IpcError = AppError::Other("save cancelled".into()).into();
        assert_eq!(ipc.code, ErrorCode::Cancelled);
        assert!(!ipc.recoverable);
    }

    #[test]
    fn other_generic_is_other_and_recoverable() {
        let ipc: IpcError = AppError::Other("join error: boom".into()).into();
        assert_eq!(ipc.code, ErrorCode::Other);
        assert!(ipc.recoverable);
    }

    #[test]
    fn code_variant_round_trips() {
        let err = AppError::Code {
            code: ErrorCode::ReadOnly,
            message: "file is read-only".into(),
            recoverable: true,
            details: None,
        };
        let ipc: IpcError = err.into();
        assert_eq!(ipc.code, ErrorCode::ReadOnly);
        assert_eq!(ipc.message, "file is read-only");
        assert!(ipc.recoverable);
        assert!(ipc.details.is_none());
    }

    #[test]
    fn code_variant_carries_details_through_ipc_round_trip() {
        // Regression for review issue I1: when a SaveCoordinator IpcError with
        // details (e.g. AlreadyOpen's existingId/path) is re-wrapped through
        // AppError::Code at the IPC boundary, the details must survive so the
        // frontend can focus the existing view. Without the `details` field on
        // the Code variant, they were silently dropped.
        let details = serde_json::json!({
            "existingId": "abc-123",
            "path": "/tmp/main.typ",
        });
        let err = AppError::Code {
            code: ErrorCode::AlreadyOpen,
            message: "document already open".into(),
            recoverable: true,
            details: Some(details.clone()),
        };
        // AppError::serialize emits the IpcError object; parse it back to verify
        // the details field is present on the wire (this is what the frontend
        // receives via Tauri's reject path).
        let wire = serde_json::to_value(&err).unwrap();
        assert_eq!(wire["code"], "already_open");
        assert_eq!(wire["details"], details, "details must survive the round-trip");
        assert_eq!(wire["details"]["existingId"], "abc-123");
    }

    #[test]
    fn ipc_error_serializes_as_object() {
        // CRITICAL wire-format property: the serialized form is a JSON OBJECT,
        // not a string (the old AppError::serialize emitted a string).
        let ipc = IpcError::new(ErrorCode::PermissionDenied, "denied", false);
        let v = serde_json::to_value(&ipc).unwrap();
        assert!(v.is_object(), "IpcError must serialize as an object: {v}");
        assert_eq!(v["code"], "permission_denied");
        assert_eq!(v["message"], "denied");
        assert_eq!(v["recoverable"], false);
        // `details` omitted when None.
        assert!(
            v.get("details").is_none(),
            "details must be absent when None"
        );
    }

    #[test]
    fn ipc_error_with_details_serializes_them() {
        let ipc = IpcError::new(ErrorCode::AlreadyOpen, "open", true)
            .with_details(serde_json::json!({ "path": "/x" }));
        let v = serde_json::to_value(&ipc).unwrap();
        assert_eq!(v["details"]["path"], "/x");
    }

    #[test]
    fn cancelled_helper_sets_code_and_not_recoverable() {
        let ipc = IpcError::cancelled("user dismissed the dialog");
        assert_eq!(ipc.code, ErrorCode::Cancelled);
        assert!(!ipc.recoverable);
    }

    #[test]
    fn error_code_serializes_snake_case() {
        // ErrorCode variants serialize as bare JSON strings ("permission_denied").
        assert_eq!(
            serde_json::to_value(ErrorCode::PermissionDenied).unwrap(),
            serde_json::Value::String("permission_denied".to_string())
        );
        assert_eq!(
            serde_json::to_value(ErrorCode::IoTransient).unwrap(),
            serde_json::Value::String("io_transient".to_string())
        );
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        ErrorCode::export(&cfg).unwrap();
        IpcError::export(&cfg).unwrap();
    }
}
