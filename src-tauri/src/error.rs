//! Unified error type for the application.

use thiserror::Error;

use crate::ipc::error::ErrorCode;

/// Top-level error type propagated across layers.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("typst compile failed")]
    Compile,

    #[error("export failed: {0}")]
    Export(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// A document at the given canonical path is already open (§4.1 uniqueness).
    /// Carries the existing document's id so callers can focus its view instead
    /// of creating a duplicate.
    #[error("document already open: {path} (id {existing_id})")]
    AlreadyOpen {
        existing_id: crate::domain::document::DocumentId,
        path: String,
    },

    #[error("{0}")]
    Other(String),

    /// Generic structured escape hatch (§5.3). Lets a producer (e.g. the
    /// [`SaveCoordinator`](crate::service::save_coordinator::SaveCoordinator))
    /// surface a save-specific [`ErrorCode`] that has no dedicated enum variant
    /// (e.g. `ReadOnly`, `ParentMissing`, `PathOccupied`, `ExternalConflict`)
    /// without bloating this enum with one variant per code.
    ///
    /// The typed variants above (`Io`, `NotFound`, …) remain the **primary**
    /// path — they're what callers produce for the common failures. `Code` is
    /// reserved for the save-coordinator's classified codes and any future
    /// structured producer that doesn't fit a typed variant.
    ///
    /// `details` carries structured fields that must survive the IPC round-trip
    /// (e.g. `AlreadyOpen` re-uses `Code` when re-wrapping a SaveCoordinator
    /// `IpcError`; the `existingId`/`path` are carried in `details` so the
    /// frontend can focus the existing view).
    #[error("{message}")]
    Code {
        code: ErrorCode,
        message: String,
        recoverable: bool,
        // Carried through the custom `Serialize` impl below (which omits
        // `details` when None). Not annotated with serde attrs because AppError
        // uses a hand-written Serialize, not a derive.
        details: Option<serde_json::Value>,
    },
}

pub type Result<T> = std::result::Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // §5.3: emit a structured IpcError OBJECT (not a string) so the frontend
        // can branch on `code`. This changes the wire format from a plain string
        // to `{ code, message, details?, recoverable }`; the frontend's
        // `toIpcError` narrows the rejected `unknown` back to the typed shape.
        use serde::ser::SerializeStruct;
        let ipc = crate::ipc::error::IpcError::from(self);
        let mut st = serializer.serialize_struct("IpcError", 4)?;
        st.serialize_field("code", &ipc.code)?;
        st.serialize_field("message", &ipc.message)?;
        // Omit `details` when None — matches IpcError's own #[skip_serializing_if].
        if let Some(details) = &ipc.details {
            st.serialize_field("details", details)?;
        }
        st.serialize_field("recoverable", &ipc.recoverable)?;
        st.end()
    }
}
