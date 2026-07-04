//! `.bak` + corrupt-file recovery for state files (§5.2, last paragraph).
//!
//! Session, settings, and (future) recovery-manifest persistence all overwrite
//! a single JSON file in place. Atomic writes (see [`super::atomic`]) guarantee
//! the destination is never half-written, but they cannot protect against a
//! file that was *already* corrupt on disk before this process ran (e.g. a
//! hand-edit, a partial write from an older non-atomic build, or filesystem
//! damage). For those cases §5.2 requires:
//!
//! 1. keep the most recent **known-good** copy as `<path>.bak`;
//! 2. on a corrupt main file, fall back to `.bak`;
//! 3. rename the corrupt main file to `<path>.corrupt-<ts>` (preserve it for
//!    diagnosis, don't silently drop the user's data);
//! 4. record a diagnostic and continue startup.
//!
//! This module provides two building blocks used by both `SessionService` and
//! `JsonFileStore`:
//! - [`load_json_with_backup`] — read main, fall back to `.bak`, quarantine a
//!   corrupt main;
//! - [`write_with_backup`] — atomic write of the new value **and** rotation of
//!   the previous known-good bytes into `.bak`.
//!
//! ## Sanitization (§7.4)
//! Only paths and outcomes are logged here, never document text. The callers
//! (`session.json`, `settings.json`) carry no document bodies, but the rule is
//! kept anyway for consistency with the rest of `persistence`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::Result;

/// Outcome of loading a JSON state file with `.bak` fallback (§5.2).
#[derive(Debug)]
pub enum LoadOutcome<T> {
    /// The main file loaded fine.
    Primary(T),
    /// The main file was corrupt/unreadable; the `.bak` loaded instead.
    /// `corrupt_path` is where the corrupt main file was moved (for
    /// diagnostics / a "startup problems" banner).
    RestoredFromBackup { value: T, corrupt_path: PathBuf },
    /// Neither main nor `.bak` was available/loadable; the caller should use
    /// defaults.
    MissingOrUnrecoverable,
}

/// Load JSON from `path` with a `.bak` fallback (§5.2).
///
/// Decision tree:
/// - If the main file reads and parses cleanly → [`LoadOutcome::Primary`].
/// - If the main file is missing/unreadable/corrupt:
///   - the corrupt main (if it exists) is moved aside to
///     `<stem>.corrupt-<unix-ts><ext>` (best-effort; a rename failure is logged
///     and skipped so we still try the `.bak`);
///   - if the `.bak` reads and parses → [`LoadOutcome::RestoredFromBackup`]
///     carrying the path the corrupt main was moved to (or `None`-equivalent:
///     the path under which it *would* have been quarantined if the rename
///     failed, the caller logs regardless);
///   - else → [`LoadOutcome::MissingOrUnrecoverable`] (caller uses defaults).
///
/// `parse` is typically `serde_json::from_str`; it is passed as a closure so
/// the same helper serves the typed `Session` path and the free-form
/// `serde_json::Value` settings path.
///
/// # Errors
/// Only propagates I/O errors that occur while reading a file that *exists*
/// (e.g. a permissions failure on the main file with no usable `.bak`). A
/// genuine parse failure never returns `Err` — it is the corrupt path, which
/// degrades to backup or `MissingOrUnrecoverable`.
pub fn load_json_with_backup<T, E>(
    path: &Path,
    parse: impl Fn(&str) -> std::result::Result<T, E>,
) -> Result<LoadOutcome<T>>
where
    E: std::fmt::Display,
{
    // Try the main file first.
    match read_and_parse(path, &parse) {
        ReadResult::Ok(value) => Ok(LoadOutcome::Primary(value)),
        ReadResult::Missing => {
            // Main absent. Try the .bak directly (no corrupt-rename needed —
            // there is nothing to quarantine).
            Ok(try_backup(path, &parse))
        }
        ReadResult::Corrupt => {
            // Main is corrupt — quarantine it (best-effort), then try .bak.
            let corrupt_path = quarantine_corrupt(path);
            Ok(try_backup_with_corrupt(path, &parse, corrupt_path))
        }
    }
}

/// Write `bytes` to `path` atomically, AND rotate the previous successful
/// content into `<path>.bak` (§5.2).
///
/// The `.bak` is the **last known good** — so a corrupt *current* write must
/// not poison the backup. Ordering:
/// 1. Read the current file's bytes (if any) into memory *before* writing.
/// 2. Atomically write the new bytes (replacing main) via [`atomic::write_bytes`].
/// 3. If the pre-write read succeeded, write those old bytes to `<path>.bak`
///    (also atomically, so the backup itself can't be half-written).
///
/// Crash window analysis:
/// - Crash before step 2 → main unchanged (still old), no `.bak` change.
/// - Crash between 2 and 3 → main = new, `.bak` = previous-old (or absent on
///   first write). Both are valid, parseable files; recovery still works.
/// - Crash during step 3 → the `.bak` write is itself atomic, so `.bak` is
///   either fully old or fully new-but-equal-to-old's-predecessor — never torn.
///
/// A first-ever write (no prior file) writes the main only; the `.bak` is left
/// absent and no error is raised.
///
/// **Concurrency contract:** the read-previous → write-main → write-`.bak`
/// sequence is NOT internally locked. Callers that share a path (e.g. session
/// or settings persistence) MUST serialize calls to the same path — the
/// service's in-memory state lock does NOT cover this three-step sequence on
/// its own. Without serialization two concurrent writers can interleave such
/// that `.bak` ends up one generation stale (the live main is always correct
/// because step 2 is atomic; only the backup rotation can lose a generation).
/// In practice both callers (`SessionService`, `SettingsService`) drop their
/// lock before invoking this — acceptably stale `.bak` is the worst case, and
/// `save_session` is frontend-debounced while settings writes are rare user
/// actions, so real concurrency is unlikely. If that ever changes, hold the
/// service lock across the `write_with_backup` call to make the rotation
/// airtight.
///
/// [`atomic::write_bytes`]: super::atomic::write_bytes
pub fn write_with_backup(path: &Path, bytes: &[u8]) -> Result<()> {
    // Step 1: snapshot the current bytes BEFORE overwriting. A missing file or
    // read error here is fine — it just means there is no known-good previous
    // to rotate into .bak (first write, or unreadable current). We do NOT
    // surface that as an error: the new write must still proceed.
    let previous_bytes = read_bytes_if_exists(path);

    // Step 2: atomic replace of main. This is the durability-critical step.
    super::atomic::write_bytes(path, bytes)?;

    // Step 3: best-effort rotation of the previous content into .bak. We use
    // the atomic writer here too so the backup can't be torn. Errors are
    // logged and swallowed: losing the .bak rotation is not a data-loss event
    // (the main write already succeeded).
    if let Some(old) = previous_bytes {
        let bak = backup_path(path);
        if let Err(e) = super::atomic::write_bytes(&bak, &old) {
            tracing::warn!(
                ?path, ?bak, error = %e,
                "write_with_backup: .bak rotation failed (main write succeeded)",
            );
        }
    }
    Ok(())
}

// --- internals --------------------------------------------------------------

/// Read+parse outcome for a single file.
enum ReadResult<T> {
    /// File exists, read ok, parse ok.
    Ok(T),
    /// File does not exist (or is unreadable as not-found).
    Missing,
    /// File exists and was read, but failed to parse (corrupt).
    Corrupt,
}

fn read_and_parse<T, E>(path: &Path, parse: &impl Fn(&str) -> std::result::Result<T, E>) -> ReadResult<T>
where
    E: std::fmt::Display,
{
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ReadResult::Missing,
        // Any other read error (permission denied, etc.) is treated like
        // corrupt: we cannot trust the file, so try the .bak. This is
        // intentionally lenient — startup must not abort on one bad file.
        Err(e) => {
            tracing::warn!(?path, error = %e, "backup: main file unreadable, treating as corrupt");
            return ReadResult::Corrupt;
        }
    };
    match parse(&raw) {
        Ok(value) => ReadResult::Ok(value),
        Err(e) => {
            tracing::warn!(?path, error = %e, "backup: main file failed to parse, treating as corrupt");
            ReadResult::Corrupt
        }
    }
}

/// Try the `.bak`. No corrupt-main quarantine (caller already handled it).
fn try_backup<T, E>(path: &Path, parse: &impl Fn(&str) -> std::result::Result<T, E>) -> LoadOutcome<T>
where
    E: std::fmt::Display,
{
    let bak = backup_path(path);
    match read_and_parse(&bak, parse) {
        ReadResult::Ok(value) => {
            tracing::warn!(?path, ?bak, "backup: main missing, restored from .bak");
            LoadOutcome::RestoredFromBackup {
                value,
                // No corrupt file was quarantined (main was simply absent).
                // Surface the (non-existent) main path itself rather than the
                // .bak — there is no corrupt artifact to point the user at.
                corrupt_path: path.to_path_buf(),
            }
        }
        _ => LoadOutcome::MissingOrUnrecoverable,
    }
}

/// Try the `.bak` after a corrupt main was (best-effort) quarantined.
fn try_backup_with_corrupt<T, E>(
    path: &Path,
    parse: &impl Fn(&str) -> std::result::Result<T, E>,
    corrupt_path: Option<PathBuf>,
) -> LoadOutcome<T>
where
    E: std::fmt::Display,
{
    let bak = backup_path(path);
    match read_and_parse(&bak, parse) {
        ReadResult::Ok(value) => {
            tracing::warn!(
                ?path, ?bak, corrupt_path = ?corrupt_path,
                "backup: main corrupt, restored from .bak",
            );
            // If the quarantine rename failed, still report success but surface
            // the intended corrupt path so callers can log it.
            LoadOutcome::RestoredFromBackup {
                value,
                corrupt_path: corrupt_path.unwrap_or_else(|| path.with_extension("corrupt")),
            }
        }
        _ => {
            tracing::warn!(
                ?path, ?bak, corrupt_path = ?corrupt_path,
                "backup: main corrupt and .bak missing/unusable; falling back to defaults",
            );
            LoadOutcome::MissingOrUnrecoverable
        }
    }
}

/// Move a corrupt main file aside to `<stem>.corrupt-<unix-ts><ext>` so the
/// user's data is preserved for diagnosis (§5.2 step 2). Best-effort: on
/// rename failure we log and proceed to try the `.bak` anyway. Returns the
/// quarantine path if the rename succeeded, else `None`.
fn quarantine_corrupt(path: &Path) -> Option<PathBuf> {
    // Use sub-millisecond precision to avoid same-second collisions when two
    // corruptions happen back-to-back (the rename would otherwise target an
    // existing quarantine path and fail). Falls back to a counter suffix if
    // the high-resolution timestamp somehow still collides.
    let ts = unix_timestamp();
    let mut dest = corrupt_path(path, ts);
    match std::fs::rename(path, &dest) {
        Ok(()) => {
            tracing::warn!(?path, ?dest, "backup: corrupt main quarantined");
            Some(dest)
        }
        Err(e) => {
            // Retry once with a counter suffix (handles same-timestamp collision).
            dest = corrupt_path(path, ts);
            if let Some(s) = dest.file_stem().and_then(|s| s.to_str()) {
                let _ = s; // stem already embedded; append a disambiguator below
            }
            dest = {
                let parent = dest.parent().unwrap_or_else(|| Path::new("."));
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("data");
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("json");
                parent.join(format!("{stem}.corrupt-{ts}-2.{ext}"))
            };
            match std::fs::rename(path, &dest) {
                Ok(()) => {
                    tracing::warn!(?path, ?dest, "backup: corrupt main quarantined (retry)");
                    Some(dest)
                }
                Err(e2) => {
                    // Best-effort: log and continue. Do NOT delete the corrupt file —
                    // §5.2 wants it preserved. We leave it in place and the caller
                    // will use the .bak; the corrupt file remains alongside.
                    tracing::warn!(
                        ?path, ?dest, error = %e, error2 = %e2,
                        "backup: could not rename corrupt main aside; leaving in place",
                    );
                    None
                }
            }
        }
    }
}

/// `<path>.bak`.
fn backup_path(path: &Path) -> PathBuf {
    // Append ".bak" to the whole file name (preserves extension for clarity):
    // `session.json` → `session.json.bak`.
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    name.push_str(".bak");
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .join(name)
}

/// Quarantine path: `<stem>.corrupt-<unix-ms><ext>` (e.g.
/// `session.corrupt-1720000000123.json`). Keeps the original extension so the
/// user can still open/inspect it; millisecond precision avoids same-second
/// collisions.
fn corrupt_path(path: &Path, ts: u64) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_else(|| "json".to_string());
    parent.join(format!("{stem}.corrupt-{ts}.{ext}"))
}

/// Current Unix timestamp in **milliseconds** (best-effort; falls back to 0 if
/// the clock is before epoch). Millisecond precision avoids same-second
/// collisions in quarantine names when two corruptions happen back-to-back;
/// the rename-retry in [`quarantine_corrupt`] is the second line of defense.
fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read the file's bytes if it exists; `None` if missing or unreadable. Used
/// by [`write_with_backup`] to snapshot the previous known-good before the
/// atomic replace.
fn read_bytes_if_exists(path: &Path) -> Option<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!(
                ?path, error = %e,
                "write_with_backup: could not read previous file; .bak will not be rotated",
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// A unique temp dir per test, canonicalized (macOS `/var` → `/private/var`).
    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::domain::path::canonicalize_for_identity(&dir)
            .unwrap_or_else(|_| dir.canonicalize().unwrap_or(dir))
    }

    /// Parse a JSON string into `T` (the typical closure passed in production).
    fn parse_json<T: for<'de> Deserialize<'de>>(s: &str) -> std::result::Result<T, serde_json::Error> {
        serde_json::from_str(s)
    }

    fn write(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn primary_loads_when_valid() {
        let dir = tmp_dir();
        let path = dir.join("state.json");
        write(&path, r#"{"v": 7}"#);

        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();

        match outcome {
            LoadOutcome::Primary(val) => assert_eq!(val, serde_json::json!({"v": 7})),
            other => panic!("expected Primary, got {other:?}"),
        }
    }

    #[test]
    fn corrupt_main_falls_back_to_bak() {
        let dir = tmp_dir();
        let path = dir.join("state.json");
        let bak = backup_path(&path);

        // Good .bak, garbage main.
        write(&bak, r#"{"v": 9}"#);
        write(&path, "{ not json");

        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();

        match outcome {
            LoadOutcome::RestoredFromBackup { value, corrupt_path } => {
                assert_eq!(value, serde_json::json!({"v": 9}), "should restore the .bak value");
                // The corrupt main must have been renamed aside (not left in place).
                assert!(
                    !path.exists(),
                    "corrupt main should have been moved away, still exists at {path:?}"
                );
                let moved = corrupt_path.file_name().unwrap().to_string_lossy().into_owned();
                assert!(
                    moved.starts_with("state.corrupt-"),
                    "corrupt rename should follow the .corrupt-<ts> pattern, got {moved:?}"
                );
                assert!(
                    moved.ends_with(".json"),
                    "corrupt rename should keep the .json extension, got {moved:?}"
                );
            }
            other => panic!("expected RestoredFromBackup, got {other:?}"),
        }
    }

    #[test]
    fn both_corrupt_returns_missing() {
        let dir = tmp_dir();
        let path = dir.join("state.json");
        let bak = backup_path(&path);

        // Garbage main + garbage .bak.
        write(&path, "{ broken");
        write(&bak, "{ also broken");

        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();
        // No panic; degrades to MissingOrUnrecoverable.
        assert!(
            matches!(outcome, LoadOutcome::MissingOrUnrecoverable),
            "expected MissingOrUnrecoverable, got {outcome:?}",
        );

        // Garbage main + MISSING .bak also degrades cleanly.
        std::fs::remove_file(&bak).unwrap();
        write(&path, "{ broken again");
        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();
        assert!(
            matches!(outcome, LoadOutcome::MissingOrUnrecoverable),
            "garbage main + missing bak should be MissingOrUnrecoverable",
        );
    }

    #[test]
    fn missing_main_missing_bak_returns_missing() {
        let dir = tmp_dir();
        let path = dir.join("never-existed.json");

        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();
        assert!(
            matches!(outcome, LoadOutcome::MissingOrUnrecoverable),
            "neither file present should be MissingOrUnrecoverable, got {outcome:?}",
        );
    }

    #[test]
    fn write_with_backup_rotates_previous_to_bak() {
        let dir = tmp_dir();
        let path = dir.join("state.json");
        let bak = backup_path(&path);

        // Write A.
        write_with_backup(&path, b"{\"v\":1}").unwrap();
        assert!(path.exists());
        assert!(!bak.exists(), "first write should produce no .bak");

        // Write B.
        write_with_backup(&path, b"{\"v\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"v\":2}", "main = B");
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), "{\"v\":1}", "bak = A (rotated)");
    }

    #[test]
    fn write_with_backup_first_write_has_no_bak() {
        let dir = tmp_dir();
        let path = dir.join("fresh.json");
        let bak = backup_path(&path);

        // First ever write — no prior file to rotate.
        write_with_backup(&path, b"{\"v\":1}").unwrap();
        assert!(path.exists(), "main must be written");
        assert!(!bak.exists(), "no prior content → no .bak");
    }

    #[test]
    fn write_with_backup_then_corrupt_recovers() {
        // End-to-end: a few writes build up a .bak, then a simulated corrupt
        // main (hand-written garbage) should still recover the last known-good
        // via load_json_with_backup.
        let dir = tmp_dir();
        let path = dir.join("state.json");

        write_with_backup(&path, b"{\"v\":1}").unwrap();
        write_with_backup(&path, b"{\"v\":2}").unwrap();
        // main = {"v":2}, bak = {"v":1}

        // Simulate corruption of the main file (e.g. another process, or a
        // pre-atomic legacy write).
        std::fs::write(&path, "{ totally not json").unwrap();

        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();
        match outcome {
            LoadOutcome::RestoredFromBackup { value, .. } => {
                assert_eq!(value, serde_json::json!({"v": 1}), "should fall back to .bak");
            }
            other => panic!("expected RestoredFromBackup, got {other:?}"),
        }
    }

    #[test]
    fn corrupt_rename_keeps_extension_and_stem() {
        // Sanity-check the naming helper directly: `session.json` →
        // `session.corrupt-<ts>.json`.
        let p = Path::new("/tmp/session.json");
        let c = corrupt_path(p, 1_720_000_000);
        assert_eq!(
            c.file_name().unwrap(),
            "session.corrupt-1720000000.json",
        );

        // A file with no extension defaults to `.json`.
        let p2 = Path::new("/tmp/settings");
        let c2 = corrupt_path(p2, 1_720_000_000);
        assert_eq!(c2.file_name().unwrap(), "settings.corrupt-1720000000.json");
    }

    #[test]
    fn backup_path_is_sibling_with_bak_suffix() {
        let p = Path::new("/tmp/state.json");
        let b = backup_path(p);
        assert_eq!(b, Path::new("/tmp/state.json.bak"));
    }

    #[test]
    fn load_returns_primary_when_both_valid_prefers_main() {
        // Even if a .bak exists, a valid main takes priority.
        let dir = tmp_dir();
        let path = dir.join("state.json");
        let bak = backup_path(&path);
        write(&path, r#"{"v": "main"}"#);
        write(&bak, r#"{"v": "bak"}"#);

        let outcome: LoadOutcome<serde_json::Value> =
            load_json_with_backup(&path, parse_json).unwrap();
        match outcome {
            LoadOutcome::Primary(val) => assert_eq!(val["v"], "main"),
            other => panic!("expected Primary, got {other:?}"),
        }
    }
}
