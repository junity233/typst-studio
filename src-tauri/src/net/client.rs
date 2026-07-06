//! Reusable HTTP client + fetch options.
//!
//! [`HttpClient`] wraps a [`reqwest::Client`] with a sane redirect policy. It
//! is intentionally generic (not paste-specific) so future features — font /
//! package downloads, update checks — can reuse it. Paste's remote-image
//! download is simply the first caller.

use std::time::Duration;

/// Per-request fetch options: an overall timeout and a hard size cap.
#[derive(Clone, Copy, Debug)]
pub struct FetchOptions {
    /// Total wall-clock deadline for the request (connect + read).
    pub timeout: Duration,
    /// Maximum acceptable response size in bytes. Enforced both via
    /// `Content-Length` (rejected before bodies are read) and after the body
    /// is fully buffered (defends against missing/lying headers).
    pub max_bytes: u64,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            max_bytes: 50 * 1024 * 1024,
        }
    }
}

/// A thin wrapper around [`reqwest::Client`] shared app-wide via
/// [`AppState`](crate::ipc::state::AppState).
pub struct HttpClient {
    // `pub(super)` so the `impl HttpClient { fetch_* }` block in the sibling
    // `fetch.rs` can drive requests without exposing reqwest to callers.
    pub(super) client: reqwest::Client,
}

impl HttpClient {
    /// Build a client with up to 10 redirected hops followed automatically.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("reqwest client build");
        Self { client }
    }

    /// Borrow the underlying client for streaming requests (the AI proxy).
    /// The field is `pub(super)` to keep reqwest out of the public API; this
    /// accessor is the sanctioned way for sibling modules to issue streaming
    /// POSTs that `fetch_to_file`/`fetch_bytes` (both GET, both buffered) can't.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new()
    }
}
