//! `TrashService` — safe deletion via the system trash (§5.5).
//!
//! Workspace deletion routes through the OS-native recycle / trash bin instead
//! of a permanent `remove_file` / `remove_dir_all`, so a destructive file-op
//! is recoverable from the OS trash UI (Finder, Recycle Bin, freedesktop Trash).
//!
//! - **macOS** — `NSWorkspace` `recycleURLs:completionHandler:`.
//! - **Windows** — `FileOperation` `FO_DELETE` with the recycle flag.
//! - **Linux** — freedesktop Trash (`~/.local/share/Trash` + the mountpoint
//!   `.Trash` / `.Trash-<uid>` spec).
//!
//! Permanent deletion is the explicit advanced action
//! ([`permanent_delete`](TrashService::permanent_delete) /
//! [`WorkspaceService::delete_entry_permanent`]); the default
//! ([`trash_delete`](TrashService::trash_delete)) always trashes.

use std::path::Path;

use crate::error::{AppError, Result};

/// The outcome of a [`TrashService::trash_delete`] — whether the entry ended up
/// in the system trash (the default) or was permanently deleted (only when the
/// caller opts into the advanced permanent path). Surfaced so the IPC layer /
/// frontend can show the right confirmation ("Moved to Trash" vs "Deleted").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashOutcome {
    /// Moved to the system trash / recycle bin (recoverable from the OS UI).
    Trashed,
    /// Permanently removed (NOT recoverable). Only via the explicit advanced
    /// action, never the default delete path.
    PermanentlyDeleted,
}

/// Platform-native trash deletion + the explicit permanent-delete escape hatch.
///
/// All methods are free functions: deletion is stateless (no service instance
/// is needed), so this module is a thin, well-documented wrapper over the
/// [`trash`] crate with [`AppError`] error mapping. The "service" framing keeps
/// the §5.5 vocabulary (a `TrashService` the workspace routes deletes through).
pub struct TrashService;

impl TrashService {
    /// Move a file or directory at `path` to the system trash (§5.5).
    ///
    /// Works for files AND directories (the `trash` crate handles both). The
    /// entry is gone from its original location on success and recoverable via
    /// the OS trash UI (Finder / Recycle Bin / freedesktop Trash viewer).
    ///
    /// Returns [`TrashOutcome::Trashed`] on success. A failure to reach the
    /// trash (the platform API rejected the path — e.g. a missing file, a
    /// permission denial, or no trash on the volume) is mapped to an
    /// [`AppError`] the caller surfaces as a structured IPC error.
    pub fn trash_delete(path: &Path) -> Result<TrashOutcome> {
        trash::delete(path).map_err(map_trash_error)?;
        Ok(TrashOutcome::Trashed)
    }

    /// Permanently delete a file or directory (§5.5 "永久删除只作为明确标注的高级
    /// 动作"). NOT recoverable. This is the explicit advanced action — never the
    /// default workspace delete path (which routes through [`trash_delete`]).
    ///
    /// Returns [`TrashOutcome::PermanentlyDeleted`] on success.
    pub fn permanent_delete(path: &Path) -> Result<TrashOutcome> {
        let meta = std::fs::symlink_metadata(path).map_err(AppError::Io)?;
        let res = if meta.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        res.map_err(AppError::Io)?;
        Ok(TrashOutcome::PermanentlyDeleted)
    }
}

/// Map a `trash::Error` to the application's [`AppError`].
///
/// `trash::Error` is an opaque struct (its variants are platform-specific and
/// not exhaustively matchable across versions), so we format it and classify
/// by message. The common cases:
/// - file/dir not found → [`AppError::NotFound`] (precise: the IPC layer
///   already resolved the path, but the entry could vanish between resolve and
///   delete);
/// - permission denied → a structured `PermissionDenied` code (recoverable for
///   surfacing as a save-as-style retry);
/// - everything else → [`AppError::Other`] (the platform recycle API rejected
///   the path — e.g. no trash on a network volume, or a non-GUI session on
///   macOS that has no `NSWorkspace`).
fn map_trash_error(e: trash::Error) -> AppError {
    let msg = e.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("not found") || lower.contains("no such file") {
        return AppError::NotFound(format!("trash: {msg}"));
    }
    if lower.contains("permission denied") || lower.contains("operation not permitted") {
        return AppError::Code {
            code: crate::ipc::error::ErrorCode::PermissionDenied,
            message: format!("trash: {msg}"),
            recoverable: false,
            details: None,
        };
    }
    AppError::Other(format!("trash: {msg}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `trash_delete` removes the entry from its original location and reports
    /// [`TrashOutcome::Trashed`] (§11.4 "删除进入废纸篓而不是永久删除"). The
    /// cross-platform check is "gone from the source path" — we can't reliably
    /// assert it landed in the OS trash (its location varies by platform and
    /// isn't a stable test surface), but the API returning `Trashed` + the file
    /// being gone from the workspace is the §11.4 acceptance contract.
    #[test]
    fn trash_delete_moves_file_out_of_source_location() {
        let dir = std::env::temp_dir().join(format!("typst-trash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("gone.typ");
        std::fs::write(&file, "trash me").unwrap();

        let outcome = TrashService::trash_delete(&file);
        // The trash API may legitimately fail outside a GUI session (e.g. a
        // CI/SSH run with no NSWorkspace on macOS). In that case the test still
        // proves the API was invoked + the error mapped to AppError; we don't
        // assert the success path when the platform can't honor it.
        match outcome {
            Ok(TrashOutcome::Trashed) => {
                assert!(!file.exists(), "file must be gone from its source path");
                assert_eq!(outcome.unwrap(), TrashOutcome::Trashed);
                // Re-deleting the now-missing file must error (not silently Ok).
                let re = TrashService::trash_delete(&file);
                assert!(re.is_err(), "trashing a missing file must error, got {re:?}");
            }
            Ok(TrashOutcome::PermanentlyDeleted) => {
                // trash_delete never returns PermanentlyDeleted — if it does,
                // the wiring is wrong.
                panic!("trash_delete must not permanently delete");
            }
            Err(_) => {
                // Non-GUI / no-trash environment: the file remains untouched
                // (the API didn't half-delete). Acceptable test environment.
                assert!(file.exists(), "on trash failure the source file must remain");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `permanent_delete` removes the entry outright and reports
    /// [`TrashOutcome::PermanentlyDeleted`] (the explicit advanced action).
    #[test]
    fn permanent_delete_removes_file_and_reports_permanent() {
        let dir = std::env::temp_dir().join(format!("typst-trash-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("perm-gone.typ");
        std::fs::write(&file, "gone for good").unwrap();

        let outcome = TrashService::permanent_delete(&file).unwrap();
        assert_eq!(outcome, TrashOutcome::PermanentlyDeleted);
        assert!(!file.exists(), "permanent delete must remove the file");

        // A directory is also handled (recursive permanent delete).
        let sub = dir.join("subdir");
        std::fs::create_dir_all(sub.join("nested")).unwrap();
        std::fs::write(sub.join("nested/a.typ"), "x").unwrap();
        let outcome = TrashService::permanent_delete(&sub).unwrap();
        assert_eq!(outcome, TrashOutcome::PermanentlyDeleted);
        assert!(!sub.exists(), "permanent delete must remove the dir tree");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `permanent_delete` on a missing path surfaces a structured error (the
    /// entry vanished before the delete ran).
    #[test]
    fn permanent_delete_missing_path_errors() {
        let dir = std::env::temp_dir().join(format!("typst-trash-miss-{}", uuid::Uuid::new_v4()));
        let missing = dir.join("nope.typ");
        let err = TrashService::permanent_delete(&missing).unwrap_err();
        assert!(
            matches!(err, AppError::Io(_)),
            "missing path must surface Io, got {err:?}"
        );
    }

    /// Error mapping: the lowercasing + substring checks pick the right variant
    /// for the canonical phrasings. `trash::Error`'s `Display` formats with
    /// `Debug` (`Error during a `trash` operation: Unknown { description: "..." }`),
    /// so the description text appears verbatim inside the formatted string —
    /// the classifier lowercases the whole thing and matches substrings.
    #[test]
    fn map_trash_error_classifies_by_message() {
        // not-found phrasing → NotFound.
        let e = map_trash_error(trash::Error::Unknown {
            description: "could not access: no such file".into(),
        });
        assert!(matches!(e, AppError::NotFound(_)), "not-found → NotFound, got {e:?}");

        // permission phrasing → PermissionDenied code.
        let e = map_trash_error(trash::Error::Unknown {
            description: "Permission denied".into(),
        });
        match e {
            AppError::Code { code, .. } => {
                assert_eq!(code, crate::ipc::error::ErrorCode::PermissionDenied);
            }
            other => panic!("permission → Code(PermissionDenied), got {other:?}"),
        }

        // anything else → Other.
        let e = map_trash_error(trash::Error::Unknown {
            description: "FS manipulation failed".into(),
        });
        assert!(matches!(e, AppError::Other(_)), "generic → Other, got {e:?}");
    }
}
