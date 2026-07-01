//! Project layer — multi-file project abstractions.
//!
//! MVP stub — see roadmap. `#include` is disabled in MVP; the traits are kept
//! so future DirectoryProject / FileSystemSource implementations slot in
//! without touching the compiler or IPC layers.

pub mod model;
pub mod virtual_fs;
