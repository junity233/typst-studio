//! Network layer — reusable HTTP client.
//!
//! Exposes [`client::HttpClient`] (shared via
//! [`AppState`](crate::ipc::state::AppState)) plus [`client::FetchOptions`]
//! and the [`fetch`] extension methods. Paste's remote-image download is the
//! first consumer; future font/package/update features can reuse the same
//! client without paste-specific coupling.

pub mod client;
pub mod error;
pub mod fetch;
