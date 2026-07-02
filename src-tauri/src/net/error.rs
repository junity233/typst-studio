//! Error type for the `net` module.
//!
//! [`NetError`] is the failure surface for [`crate::net::client::HttpClient`].
//! It converts into [`crate::error::AppError`] so Tauri commands can propagate
//! it through the unified `Result` alias.

use thiserror::Error;

/// Failures from HTTP fetch operations.
#[derive(Debug, Error)]
pub enum NetError {
    #[error("invalid url scheme (only http/https allowed): {0}")]
    BadScheme(String),
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("response too large: {size} bytes (cap {cap})")]
    TooLarge { size: u64, cap: u64 },
    #[error("non-success status {0}")]
    Status(reqwest::StatusCode),
    #[error("request timed out after {0:?}")]
    Timeout(std::time::Duration),
}

impl From<NetError> for crate::error::AppError {
    fn from(e: NetError) -> Self {
        crate::error::AppError::Other(e.to_string())
    }
}
