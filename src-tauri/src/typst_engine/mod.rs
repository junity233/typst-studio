//! Typst engine layer — `EditorWorld`, compiler, font and source loaders.
//!
//! Filled in by Phase 2.

pub mod compiler;
pub mod font_loader;
pub mod source_provider;
pub mod vfs;
pub mod world;

// Re-export the primary types for convenience.
pub use vfs::{MemoryVfs, VfsEntry};
