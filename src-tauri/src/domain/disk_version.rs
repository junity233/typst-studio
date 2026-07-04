//! On-disk content identity for external-change detection (§8.4).
//!
//! When a filesystem watcher fires for an open document's file, we need to tell
//! apart three cases:
//!
//! 1. **The app's own save** — the watcher fires for the bytes we just wrote.
//!    Recognized because the on-disk version matches the version we recorded
//!    after the write (self-save suppression).
//! 2. **A timestamp-only change** — some external tool `touch`ed the file but
//!    the bytes are identical. We update our stored version but must NOT
//!    recompile (nothing to render differently).
//! 3. **A real external change** — the bytes differ from what we recorded.
//!    Reload (if the buffer is clean) or enter a `Conflict` (if it is dirty).
//!
//! [`DiskVersion`] captures only content identity: a fast non-crypto hash of the
//! bytes plus their length. The mtime is deliberately **not** part of equality,
//! so a `touch` (same bytes, new mtime) compares equal to the prior version
//! (§8.4 "仅时间戳变化但内容未变"). It is not a security primitive — its only
//! job is change detection.
//!
//! ## Hasher choice
//!
//! The crate has no existing fast-hasher dependency, so [`DiskVersion`] uses
//! [`std::collections::hash_map::DefaultHasher`] over the bytes. Its algorithm
//! (`SipHash-1-3`) is stable across runs (the random `RandomState` key only
//! applies to the `HashMap`'s *default* hasher construction — instantiating
//! `DefaultHasher::new()` directly yields the fixed-key hasher), fast enough
//! for the small `.typ` files in play, and introduces no new dependency.

use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::path::Path;

/// A snapshot of a file's on-disk content identity (§8.4).
///
/// Two versions are equal iff their content hashes AND sizes match — i.e. the
/// bytes are (almost certainly) identical. The mtime is intentionally excluded
/// from equality so a `touch` (unchanged bytes, new mtime) compares equal.
///
/// `Serialize`/`Deserialize` (added in the crash-recovery batch §5.1.2) lets a
/// [`RecoverySnapshot`](crate::persistence::recovery::RecoverySnapshot) record
/// the disk version the snapshot was captured against, so startup recovery can
/// tell whether the disk changed between snapshot capture and the next launch
/// (§5.1.3 "当前磁盘是否变化").
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct DiskVersion {
    /// Hash of the file bytes (non-crypto, fast). Combined with `size` below it
    /// uniquely identifies the content for change-detection purposes.
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub content_hash: u64,
    /// Byte length of the file. Carried alongside the hash so a collision plus
    /// a length mismatch still flags a change (belt-and-suspenders).
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub size: u64,
}

impl DiskVersion {
    /// Compute a version from in-memory bytes (e.g. the buffer we are about to
    /// save, so the imminent watcher event is recognized as self-induced).
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let mut hasher = DefaultHasher::new();
        hasher.write(bytes);
        Self {
            content_hash: hasher.finish(),
            size: bytes.len() as u64,
        }
    }

    /// Read the file at `path` and compute its version. Returns an `io::Error`
    /// if the file cannot be read (e.g. it was deleted) — callers treat that as
    /// the "file missing" case (§8.4 → `ConflictState::Missing`).
    pub fn from_path(path: &Path) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        Ok(Self::from_bytes(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_content_produces_equal_version() {
        let a = DiskVersion::from_bytes(b"#set page()\nHello");
        let b = DiskVersion::from_bytes(b"#set page()\nHello");
        assert_eq!(a, b);
    }

    #[test]
    fn different_content_produces_different_version() {
        let a = DiskVersion::from_bytes(b"hello");
        let b = DiskVersion::from_bytes(b"world");
        assert_ne!(a, b);
    }

    #[test]
    fn empty_content_is_consistent() {
        let a = DiskVersion::from_bytes(b"");
        let b = DiskVersion::from_bytes(b"");
        assert_eq!(a, b);
        assert_eq!(a.size, 0);
    }

    #[test]
    fn from_path_matches_from_bytes() {
        let tmp = std::env::temp_dir()
            .join(format!("ts-dv-match-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, b"#set page()\nHello").unwrap();
        let from_disk = DiskVersion::from_path(&tmp).unwrap();
        let from_bytes = DiskVersion::from_bytes(b"#set page()\nHello");
        assert_eq!(from_disk, from_bytes);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn from_path_errors_for_missing_file() {
        let bogus = std::env::temp_dir()
            .join(format!("ts-dv-missing-{}.typ", uuid::Uuid::new_v4()));
        assert!(DiskVersion::from_path(&bogus).is_err());
    }

    /// §8.4 "仅时间戳变化但内容未变": a `touch` (same bytes, new mtime) must NOT
    /// change the version. Equality is content-only — mtime is excluded.
    #[test]
    fn touch_only_change_keeps_version_equal() {
        let tmp = std::env::temp_dir()
            .join(format!("ts-dv-touch-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, b"same bytes").unwrap();
        let before = DiskVersion::from_path(&tmp).unwrap();

        // Force a new mtime by sleeping briefly then rewriting the same bytes.
        // (Rewriting guarantees the mtime advances even on filesystems with
        // coarse mtime granularity.)
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&tmp, b"same bytes").unwrap();
        let after = DiskVersion::from_path(&tmp).unwrap();

        assert_eq!(
            before, after,
            "a touch (identical content, new mtime) must not change the version"
        );
        let _ = std::fs::remove_file(&tmp);
    }
}
