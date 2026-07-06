//! Atomic write protocol implementation (§5.2).
//!
//! See [`write_bytes`] for the protocol. Everything here is sync I/O; callers
//! that hand this off from an async Tauri command should do so via
//! `spawn_blocking` (the existing save sites already do).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::error::Result;

/// The age beyond which a leftover temp file is considered stale and removed at
/// startup (§5.2: "启动时清理超过 24 小时的本应用临时文件").
pub(crate) const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Prefix used for atomic-write temp files. They live next to their target
/// (same directory → same filesystem → atomic rename) and are hidden on Unix by
/// the leading dot. [`cleanup_stale_temps`] matches this pattern.
pub(crate) const TEMP_PREFIX: &str = ".typst-tmp-";

/// Atomically write `bytes` to `path`.
///
/// Protocol (§5.2):
/// 1. Create a unique temp file in the **same directory** as `path` (same
///    filesystem is mandatory for an atomic rename).
/// 2. Write all bytes.
/// 3. `flush` + `sync_all` the temp file (durability).
/// 4. If `path` exists, copy its permissions onto the temp file (preserve
///    mode/perms across overwrites).
/// 5. Atomic replace via `rename`. On Unix `std::fs::rename` is atomic and
///    overwrites; the Windows branch is written defensively but needs CI
///    validation (see below).
/// 6. Best-effort `sync_all` of the parent directory (Unix only; errors
///    ignored) so the rename itself is durable.
/// 7. On **any** failure in steps 1–6 the temp file is deleted (best-effort)
///    and the error is returned. The original file is never touched.
///
/// # Windows note
/// `std::fs::rename` on Windows is backed by `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING` since Rust 1.x, so it *can* replace an existing
/// file. If a future Windows build returns an error there, the fallback is
/// `remove_file(path)` then `rename` (non-atomic window) or the `windows` crate
/// — this needs validation on Windows CI. Only the Unix path is exercised in
/// tests on macOS dev.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temp = unique_temp_path(path);

    // Step 1–3: create, write, flush+fsync. Any error here must clean up the
    // temp file and leave the original untouched.
    let result = write_and_sync(&temp, parent, bytes);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }

    // Step 4: preserve permissions of an existing target so an overwrite does
    // not widen/narrow the mode (e.g. a 0600 file must stay 0600).
    if let Err(e) = copy_permissions_if_exists(path, &temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }

    // Step 5: atomic replace.
    if let Err(e) = atomic_replace(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }

    // Step 6: best-effort dir sync (durability of the rename entry itself).
    // Errors are intentionally swallowed — the data write is already durable.
    #[cfg(unix)]
    {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    tracing::debug!(?path, "atomic write complete");
    Ok(())
}

/// Serialize `value` as pretty JSON and write it atomically.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_bytes(path, &bytes)
}

/// Remove leftover atomic-write temp files older than 24h in `dir`.
///
/// Best-effort: individual stat/remove errors are logged and skipped so one
/// stuck file never blocks cleanup of the rest. Intended for startup (§5.2).
pub fn cleanup_stale_temps(dir: &Path) -> Result<()> {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        // Nothing to clean (e.g. dir not yet created on first launch).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let now = SystemTime::now();
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(?dir, error = %e, "cleanup_stale_temps: readdir entry skipped");
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(TEMP_PREFIX) {
            continue;
        }
        let is_stale = match entry.metadata() {
            Ok(m) => match m.modified() {
                Ok(mtime) => now.duration_since(mtime).map(|age| age > STALE_TEMP_AGE).unwrap_or(false),
                Err(e) => {
                    tracing::warn!(?name, error = %e, "cleanup_stale_temps: mtime unreadable, skipping");
                    continue;
                }
            },
            Err(e) => {
                tracing::warn!(?name, error = %e, "cleanup_stale_temps: stat failed, skipping");
                continue;
            }
        };
        if is_stale {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                tracing::warn!(?name, error = %e, "cleanup_stale_temps: remove failed, skipping");
            }
        }
    }
    Ok(())
}

// --- internals --------------------------------------------------------------

/// Build a unique temp path sibling to `path`. The name is fixed-prefix-first
/// — `.typst-tmp-<basename>-<id>` — so [`cleanup_stale_temps`] can detect the
/// whole family with a single `starts_with(TEMP_PREFIX)` regardless of which
/// target produced it. The leading dot keeps it hidden on Unix; the uuid
/// suffix avoids collisions between concurrent writers (settings + session).
fn unique_temp_path(path: &Path) -> PathBuf {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let base = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    let id = uuid::Uuid::new_v4().simple();
    dir.join(format!("{TEMP_PREFIX}{base}-{id}"))
}

/// Steps 1–3: create the temp file, write bytes, flush, fsync.
fn write_and_sync(temp: &Path, parent: &Path, bytes: &[u8]) -> Result<()> {
    // Ensure the parent exists (Save As into a fresh dir, settings on first
    // run). `create_dir_all` is a no-op if it already exists.
    std::fs::create_dir_all(parent)?;
    let mut file = std::fs::File::create(temp)?;
    use std::io::Write;
    file.write_all(bytes)?;
    file.flush()?;
    // fsync the file so a crash after this point can't lose the bytes. This is
    // the core durability guarantee; without it the rename could land before
    // the data hits disk.
    file.sync_all()?;
    Ok(())
}

/// Step 4: if `target` exists, copy its mode bits onto `temp`.
fn copy_permissions_if_exists(target: &Path, temp: &Path) -> Result<()> {
    let Ok(src) = std::fs::metadata(target) else {
        return Ok(()); // new file — nothing to preserve
    };
    let perms = src.permissions();
    std::fs::set_permissions(temp, perms)?;
    Ok(())
}

/// Step 5: platform-specific atomic replace of `target` with `temp`.
fn atomic_replace(temp: &Path, target: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        // On Unix `rename(2)` atomically replaces an existing destination.
        std::fs::rename(temp, target)?;
        Ok(())
    }
    #[cfg(windows)]
    {
        // `std::fs::rename` on Windows uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,
        // which replaces an existing file within the same volume. Try it first;
        // on the rare error (e.g. target opened with exclusive access) fall
        // back to remove-then-rename. NOTE: the fallback has a tiny window
        // where `target` is absent — acceptable for non-critical configs but
        // needs CI validation before relying on it for user documents.
        match std::fs::rename(temp, target) {
            Ok(()) => Ok(()),
            Err(rename_err) => {
                if target.exists() {
                    if let Err(remove_err) = std::fs::remove_file(target) {
                        tracing::warn!(?target, error = %remove_err, "windows atomic replace: remove fallback failed");
                        // The temp file still exists; surface the original error.
                        return Err(rename_err.into());
                    }
                }
                std::fs::rename(temp, target).map_err(|e| {
                    tracing::warn!(?target, error = %e, "windows atomic replace: fallback rename failed");
                    e.into()
                })
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::rename(temp, target)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// A unique temp dir per test, canonicalized (macOS `/var` → `/private/var`).
    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::domain::path::canonicalize_for_identity(&dir)
            .unwrap_or_else(|_| dir.canonicalize().unwrap_or(dir))
    }

    fn read(path: &Path) -> String {
        let mut s = String::new();
        std::fs::File::open(path).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn write_creates_file_with_content() {
        let dir = tmp_dir();
        let path = dir.join("new.txt");
        write_bytes(&path, b"hello").unwrap();
        assert_eq!(read(&path), "hello");
    }

    #[test]
    fn write_overwrite_is_atomic_on_success() {
        let dir = tmp_dir();
        let path = dir.join("over.txt");
        std::fs::write(&path, "OLD").unwrap();
        write_bytes(&path, b"NEW").unwrap();
        assert_eq!(read(&path), "NEW");
    }

    #[test]
    fn write_failure_does_not_truncate_original() {
        // The headline contract (§5.2): on any failure the original is
        // untouched. We trigger a failure by writing to a path whose parent is
        // itself a *file* (not a directory) — `create_dir_all` then errors with
        // NotADirectory, so the temp file is never created and the original at a
        // different path must remain byte-identical.
        let dir = tmp_dir();
        let original = dir.join("ORIGINAL.txt");
        std::fs::write(&original, "ORIGINAL-BODY").unwrap();

        // `blocker` is a regular file; treating it as a parent dir fails.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "I am a file, not a dir").unwrap();
        let bad_target = blocker.join("target.txt");
        let err = write_bytes(&bad_target, b"NEW").unwrap_err();
        assert!(
            !bad_target.exists(),
            "failed target must not be created (err: {err:?})"
        );
        assert_eq!(read(&original), "ORIGINAL-BODY", "original must be untouched");
    }

    #[cfg(unix)]
    #[test]
    fn write_failure_in_unwritable_dir_leaves_no_temp_and_original_intact() {
        // §11.2 acceptance: a failure that occurs once we're past temp creation
        // planning must still leave the original untouched AND clean up any
        // partial temp. We make the target's parent directory read+execute but
        // NOT writable (0o500): `create_dir_all` is a no-op (dir exists), then
        // `File::create(temp)` fails with PermissionDenied because the dir
        // refuses new entries. The original at a sibling path is unaffected, and
        // no temp file leaks.
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let original = dir.join("ORIGINAL.txt");
        std::fs::write(&original, "ORIGINAL-BODY").unwrap();
        let target = dir.join("target.txt");
        // Revoke directory write permission (keeps r+x so we can still resolve).
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let err = write_bytes(&target, b"NEW").unwrap_err();
        // Restore so cleanup at end of test works.
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));

        // The write failed (permission denied somewhere in the temp-create path).
        assert!(err.to_string().to_lowercase().contains("permission") || err.to_string().to_lowercase().contains("denied"),
            "expected a permission error, got: {err}");
        // Original untouched.
        assert_eq!(read(&original), "ORIGINAL-BODY");
        // No temp file leaked in the directory.
        let leaked: Vec<_> = std::fs::read_dir(&dir).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(TEMP_PREFIX))
            .collect();
        assert!(leaked.is_empty(), "a temp file leaked after failure: {leaked:?}");
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let path = dir.join("perms.txt");
        std::fs::write(&path, "OLD").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        write_bytes(&path, b"NEW").unwrap();
        assert_eq!(read(&path), "NEW");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "mode must be preserved across atomic overwrite (got {:o})",
            mode
        );
    }

    #[test]
    fn write_json_roundtrips() {
        let dir = tmp_dir();
        let path = dir.join("data.json");
        let value = serde_json::json!({ "editor": { "fontSize": 14 }, "name": "tëst" });
        write_json(&path, &value).unwrap();
        let read_back: serde_json::Value =
            serde_json::from_str(&read(&path)).unwrap();
        assert_eq!(read_back, value);
    }

    #[test]
    fn cleanup_stale_temps_removes_old_but_not_fresh() {
        // A temp file whose mtime is 25h old is removed; one with mtime now is
        // kept. We back-date via std::fs::FileTimes (stable since 1.75).
        let dir = tmp_dir();

        let old = dir.join(format!("{TEMP_PREFIX}data-old"));
        let fresh = dir.join(format!("{TEMP_PREFIX}data-fresh"));
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();

        // Back-date `old` by 25h.
        let past = SystemTime::now() - Duration::from_secs(25 * 60 * 60);
        backdate(&old, past);

        cleanup_stale_temps(&dir).unwrap();
        assert!(!old.exists(), "stale temp must be removed");
        assert!(fresh.exists(), "fresh temp must be kept");
    }

    #[test]
    fn cleanup_ignores_unrelated_files() {
        let dir = tmp_dir();
        let unrelated = dir.join(".some-other-tmp-1234");
        std::fs::write(&unrelated, b"x").unwrap();
        let past = SystemTime::now() - Duration::from_secs(48 * 60 * 60);
        backdate(&unrelated, past);
        // Does not match TEMP_PREFIX → untouched even though very old.
        cleanup_stale_temps(&dir).unwrap();
        assert!(unrelated.exists());
    }

    #[test]
    fn cleanup_missing_dir_is_ok() {
        let dir = tmp_dir();
        let absent = dir.join("does-not-exist");
        cleanup_stale_temps(&absent).expect("missing dir should not error");
    }

    #[test]
    fn concurrent_writes_do_not_corrupt() {
        // Two threads writing different content to the SAME path. Both atomic
        // renames must succeed; the final content is exactly one of the two —
        // never a half-and-half mix. A barrier maximizes overlap.
        use std::sync::{Arc, Barrier};
        let dir = tmp_dir();
        let path = Arc::new(dir.join("shared.txt"));
        let barrier = Arc::new(Barrier::new(2));

        let a = {
            let (path, barrier) = (path.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                write_bytes(&path, b"AAAA-content-A").unwrap();
            })
        };
        let b = {
            let (path, barrier) = (path.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                write_bytes(&path, b"BBBB-content-B").unwrap();
            })
        };
        a.join().unwrap();
        b.join().unwrap();

        let final_content = read(&path);
        assert!(
            final_content == "AAAA-content-A" || final_content == "BBBB-content-B",
            "concurrent atomic writes must not interleave; got: {final_content:?}"
        );
    }

    /// Set a file's mtime (and atime) to `time`. Uses `FileTimes` (stable).
    fn backdate(path: &Path, time: SystemTime) {
        // `FileTimes::set_modified`/`set_accessed` and `File::set_times` have
        // been stable on ALL platforms (incl. Windows) since Rust 1.75 — the
        // earlier `#[cfg(unix)]`-only split left the file un-backdated on
        // Windows, defeating `cleanup_stale_temps_removes_old_but_not_fresh`.
        use std::fs::FileTimes;
        let times = FileTimes::new().set_modified(time).set_accessed(time);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }
}
