//! Git integration for the Source Control view (§Source Control).
//!
//! All operations re-discover the repository per call — `gix::Repository` is
//! `Send` but not `Sync`, so it cannot live in `AppState`. Every IPC command
//! wraps its work in `spawn_blocking` (gix is heavy on file I/O).
//!
//! The status mapping is written against the **verified** gix 0.85 API (see
//! `status` module docs for the exact enum shapes read from the gix source).

pub mod operations;
pub mod status;
