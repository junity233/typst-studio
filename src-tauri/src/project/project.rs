//! `Project` trait — abstracts single-file vs directory projects.
//!
//! MVP stub. Implemented by `SingleFileProject` placeholder; the real
//! `DirectoryProject` arrives with multi-file project support.

#![allow(dead_code)]

/// A project knows how to resolve the main entry source and (eventually)
/// expose its file tree.
pub trait Project: Send + Sync {
    /// Path to the main `.typ` file, if backed by disk.
    fn main_path(&self) -> Option<&std::path::Path>;
}
