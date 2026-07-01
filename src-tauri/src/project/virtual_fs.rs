//! `VirtualFs` trait — file source for `#include` / `#read` etc.
//!
//! MVP stub. With `#include` disabled, the `EditorWorld` does not consult this
//! trait; it exists purely to fix the future extension point.

#![allow(dead_code)]

use std::path::Path;

/// Read-only virtual filesystem used by the Typst world to resolve includes.
pub trait VirtualFs: Send + Sync {
    fn read(&self, path: &Path) -> std::io::Result<Vec<u8>>;
}
