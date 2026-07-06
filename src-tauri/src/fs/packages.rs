//! Process-wide [`SystemPackages`] singleton — the bridge between typst's
//! `VirtualRoot::Package(spec)` FileIds and real package files on disk.
//!
//! This is what makes `#import "@preview/..."` and `#import "@local/..."`
//! resolve. [`SystemPackages`] consults three sources in priority order:
//!
//!   1. the **data** dir (`%APPDATA%/typst/packages` on Windows) — `@local`
//!      packages the user placed there,
//!   2. the **cache** dir (`%LOCALAPPDATA%/typst/packages` on Windows) —
//!      `@preview` packages previously downloaded,
//!   3. the **Typst Universe** registry — downloads `@preview` packages on a
//!      cache miss via the [`ReqwestDownloader`](super::downloader::ReqwestDownloader).
//!
//! The directories match the typst CLI exactly, so packages installed by a
//! prior CLI compile are reused (no re-download). Constructed once and shared
//! across every [`FileResolver`](super::resolver::FileResolver) via an
//! [`Arc`]; `SystemPackages` itself is not `Clone` (it owns a
//! `Box<dyn Downloader>`), so the singleton hands out cheap `Arc` clones.

use std::sync::{Arc, OnceLock};

use typst_kit::packages::SystemPackages;

static SYSTEM_PACKAGES: OnceLock<Arc<SystemPackages>> = OnceLock::new();

/// Build the process-wide `SystemPackages`: standard data + cache dirs (same as
/// the typst CLI) + the Typst Universe registry backed by our reqwest
/// downloader (rustls, no openssl).
fn build_packages() -> Arc<SystemPackages> {
    Arc::new(SystemPackages::new(crate::fs::downloader::ReqwestDownloader::new()))
}

/// Access the process-wide [`SystemPackages`], initializing it on first use.
/// Returns a cheap shared handle (`Arc`); the same on-disk package directories
/// back every clone.
pub fn system_packages() -> Arc<SystemPackages> {
    SYSTEM_PACKAGES
        .get_or_init(build_packages)
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_packages_is_constructible() {
        // Just confirm the singleton builds (data/cache dirs may be None in CI
        // sandboxes, which is fine — obtain() then reports NotFound). We don't
        // assert on the dirs themselves since they're environment-dependent.
        let pkgs = build_packages();
        // data/cache are Option<FsPackages>; on most dev machines at least the
        // cache dir exists. Either way construction must not panic.
        let _ = pkgs.data();
        let _ = pkgs.cache();
    }
}
