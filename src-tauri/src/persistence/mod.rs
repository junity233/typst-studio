//! Atomic, crash-safe file persistence (§5.2).
//!
//! All overwrite-in-place persistence flows through [`atomic::write_bytes`]:
//! user `.typ` saves, Save As, `session.json`, and `settings.json`. The writer
//! never truncates the destination in place — it writes a sibling temp file,
//! `fsync`s it, copies the original's permissions, then atomically renames it
//! over the target. A crash or power loss at any point leaves either the old
//! file fully intact or the new file fully written — never a half-written mix.
//!
//! ## Sanitization rule (§7.4)
//!
//! This module logs only **paths and outcomes**, never document text. Callers
//! must follow the same rule: use structured fields like
//! `tracing::debug!(?path, "saved")` and never embed file contents in a log
//! record. Clipboard contents, tokens, and network response bodies are out of
//! scope here but are likewise never logged anywhere in the app.

pub mod atomic;
pub mod backup;
pub mod migrate;
pub mod recovery;

pub use atomic::{cleanup_stale_temps, write_bytes, write_json};
pub use backup::{load_json_with_backup, write_with_backup, LoadOutcome};
pub use recovery::{RecoveryManifest, RecoveryService, RecoverySnapshot, SnapshotRef};
