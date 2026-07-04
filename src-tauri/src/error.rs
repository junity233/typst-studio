//! Unified error type for the application.

use thiserror::Error;

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
}

pub type Result<T> = std::result::Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
