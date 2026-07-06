//! Workspace filesystem layer.
//!
//! A leaf module (depends only on `std` + `notify`) that centralizes all disk
//! access for the workspace. It is shared by two consumers:
//!
//! - **`typst_engine::EditorWorld`** — to resolve `#include` / `#read` /
//!   `#image()` of files relative to the workspace root (via [`FileResolver`]),
//!   and external packages (`@preview/...`, `@local/...`) via
//!   [`packages::system_packages`].
//! - **`service::WorkspaceService`** — to build the file tree and apply file
//!   CRUD (create / rename / delete), and to watch for external changes
//!   (via [`watcher`] / [`tree`]).
//!
//! Keeping disk IO here (rather than scattered across the world and the
//! workspace service) gives a single place that owns the "root → vpath ↔ disk"
//! mapping and the ignore rules.

pub mod downloader;
pub mod packages;
pub mod resolver;
pub mod search;
pub mod tree;
pub mod watcher;

// Re-export the primary type for convenience.
pub use resolver::FileResolver;
