//! `Downloader` impl for typst-kit's package resolver — backed by reqwest +
//! rustls, NOT typst-kit's built-in `SystemDownloader`.
//!
//! typst-kit ships a `SystemDownloader` behind its `system-downloader` feature,
//! but that pulls in `ureq` + `native-tls` + `openssl`. `openssl` is painful to
//! build on Windows (the project's primary target) and would add a second
//! HTTP/TLS stack alongside the `reqwest` + `rustls-tls` client already in
//! `Cargo.toml`. Instead we implement the public [`Downloader`] trait ourselves
//! on top of `reqwest::blocking::Client` (rustls), so package auto-download
//! works with zero new TLS dependencies.
//!
//! The trait is synchronous (`download` returns `io::Result<Vec<u8>>`), called
//! from typst's package resolver on the compile worker thread. reqwest's
//! blocking client runs its own minimal runtime internally, so this works
//! outside any tokio context — important because the compile worker is a plain
//! `std::thread`, not a runtime task.

use std::io;
use std::sync::OnceLock;

use typst_kit::downloader::Downloader;

/// A process-wide blocking reqwest client reused across package downloads.
/// Built once on first use; rustls-tls (no native openssl).
fn blocking_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            // Follow the Typst Universe redirect chain (CDN hops).
            .redirect(reqwest::redirect::Policy::limited(10))
            // rustls is configured via the `rustls-tls` feature on `reqwest`.
            .build()
            .expect("reqwest blocking client build (rustls)")
    })
}

/// reqwest-backed [`Downloader`] for typst-kit's `SystemPackages`. State-less
/// beyond the shared blocking client, so cheap to construct (the
/// [`SystemPackages`](typst_kit::packages::SystemPackages) clones it by value
/// via the `impl Downloader` blanket).
#[derive(Debug, Clone, Copy)]
pub struct ReqwestDownloader;

impl ReqwestDownloader {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReqwestDownloader {
    fn default() -> Self {
        Self::new()
    }
}

impl Downloader for ReqwestDownloader {
    fn stream(
        &self,
        _key: &dyn std::any::Any,
        url: &str,
    ) -> io::Result<(Option<usize>, Box<dyn io::Read>)> {
        let resp = blocking_client().get(url).send().map_err(io_error)?;
        // Per the trait contract: a 404 must surface as `io::ErrorKind::NotFound`
        // so typst can distinguish "package doesn't exist in the registry" from a
        // transient network failure.
        if !resp.status().is_success() {
            return Err(io::Error::new(
                status_to_kind(resp.status()),
                resp.status().to_string(),
            ));
        }
        let hint = resp
            .content_length()
            .and_then(|n| usize::try_from(n).ok());
        // Buffer the full body, then return a `Cursor` as the `Read`. Package
        // archives are small (a few MB), so streaming-read-into-tar can wait for
        // the complete bytes; this avoids the complexity of a true async→sync
        // streaming bridge for reqwest's chunked body.
        let bytes = resp.bytes().map_err(io_error)?;
        let len = bytes.len();
        let reader = Box::new(io::Cursor::new(bytes.to_vec()));
        Ok((hint.or(Some(len)), reader as Box<dyn io::Read>))
    }
}

/// Map a reqwest error to an `io::Error`, preserving `NotFound` semantics when
/// the underlying cause was an HTTP 404 (reqwest may surface this as a builder
/// error depending on configuration; we normalize here).
fn io_error(e: reqwest::Error) -> io::Error {
    if e.status() == Some(reqwest::StatusCode::NOT_FOUND) {
        io::Error::new(io::ErrorKind::NotFound, e.to_string())
    } else if e.is_connect() || e.is_timeout() {
        io::Error::new(io::ErrorKind::TimedOut, e.to_string())
    } else {
        io::Error::other(e.to_string())
    }
}

/// Map an HTTP status to the `io::ErrorKind` the trait contract expects.
fn status_to_kind(status: reqwest::StatusCode) -> io::ErrorKind {
    if status == reqwest::StatusCode::NOT_FOUND {
        io::ErrorKind::NotFound
    } else {
        io::ErrorKind::Other
    }
}
