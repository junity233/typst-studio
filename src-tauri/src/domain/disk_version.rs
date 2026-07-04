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
// `Copy` (added in the conflict-close-loop batch §5.4): the struct is just two
// u64s, and `ConflictState::Modified { disk_version: Option<DiskVersion> }`
// needs the enum to stay `Copy` so the `set_conflict` helper continues to take
// it by value without churn across every call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

/// A platform file identity used to detect the `Replaced` conflict (§5.4).
///
/// Two `FileIdentity`s are equal iff their underlying inode/file-index match.
/// This is intentionally SEPARATE from [`DiskVersion`]: an external tool can
/// rewrite a file with the SAME bytes but a NEW inode (e.g. `sed -i`, an atomic
/// replace, a save-from-another-editor that writes-then-renames). The bytes are
/// identical so [`DiskVersion`] equality holds, but the file's identity changed
/// — §5.4 calls this `Replaced { identity_changed: true }` ("文件被替换为不同
/// identity 时按外部替换处理，不能只比较时间戳").
///
/// We capture this as a 64-bit hash of the `std::fs::Metadata`'s stable file-id
/// fields. On Unix that's `(dev, ino)`; on Windows `(volume_serial_number,
/// file_index)`. Both are read best-effort — if the platform won't surface a
/// stable id, [`FileIdentity::unknown`] compares equal only to itself, so the
/// `Replaced` detection degrades to "never fire" rather than false-positiving.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileIdentity(u64);

impl FileIdentity {
    /// A sentinel for "no stable identity available". Equal only to itself, so
    /// when the platform can't surface an inode the `Replaced` check never fires
    /// (degrades safely to no detection).
    pub const UNKNOWN: Self = Self(0);

    /// Read a file's identity from its metadata. Returns [`FileIdentity::UNKNOWN`]
    /// on any failure (missing file, unsupported platform) — never panics.
    pub fn from_path(path: &Path) -> Self {
        std::fs::symlink_metadata(path)
            .ok()
            .and_then(|m| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    // (dev, ino) uniquely identifies a file on a Unix volume.
                    Some(Self(hash_pair(m.dev(), m.ino())))
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    // NOTE: the ideal Windows identity is
                    // (volume_serial_number, file_index) from
                    // `GetFileInformationByHandle`, but those require the
                    // unstable `windows_by_handle` feature and so are not
                    // available on stable Rust. Fall back to the stable
                    // `MetadataExt` surface: creation_time (FILETIME, u64) +
                    // file_size. This is strictly weaker than an inode pair — a
                    // same-size rewrite that preserves creation time would not
                    // be detected as `Replaced` — but `FileIdentity` is
                    // documented best-effort and degrades safely to
                    // [`FileIdentity::UNKNOWN`] (the `Replaced` check simply
                    // never fires) when it cannot distinguish two files.
                    // TODO: restore (volume_serial_number, file_index) via the
                    // `windows-sys` crate's `GetFileInformationByHandle` for a
                    // true inode-style identity.
                    let created = m.creation_time();
                    let size = m.file_size();
                    Some(Self(hash_pair(created, size)))
                }
                #[cfg(not(any(unix, windows)))]
                {
                    None
                }
            })
            .unwrap_or(Self::UNKNOWN)
    }
}

/// Best-effort fixed-key hash of a u64 pair, mirroring the `DiskVersion` hasher
/// choice (no new dependency; stable across runs).
fn hash_pair(a: u64, b: u64) -> u64 {
    let mut h = DefaultHasher::new();
    h.write_u64(a);
    h.write_u64(b);
    h.finish()
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
