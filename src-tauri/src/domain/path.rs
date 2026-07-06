//! Canonical path helpers for document identity (§4.1).
//!
//! The canonical path is the absolute, normalized path used to compare document
//! identity. Two open documents must never share the same canonical path
//! (enforced by [`crate::domain::registry::DocumentRegistry`]).
//!
//! Rules (per the design doc):
//! - For an existing file, resolve symlinks and `.`/`..` components.
//! - For a new target (Save As), canonicalize the existing parent directory
//!   first, then append the target file name.
//! - On Windows, drive-letter casing is normalized for consistent comparison.
//! - On failure, return an error — never silently fall back to the raw path,
//!   since a non-canonical key would break the registry's uniqueness invariant.

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, Result};

/// Canonicalize a path for identity comparison.
///
/// Normalizes `.`/`..` lexically **first**, then resolves symlinks if the
/// resulting path exists on disk. This ordering matters: a path like
/// `/a/sub/../file.typ` (where `sub` doesn't exist but `file.typ` does) refers
/// to an existing file, but its raw form's `.exists()` is false because of the
/// intermediate missing component. Lexical normalization collapses it to
/// `/a/file.typ` first, so existence and symlink resolution then work.
///
/// For a not-yet-existing file (Save As target), use [`canonicalize_target`].
pub fn canonicalize_for_identity(path: &Path) -> Result<PathBuf> {
    // Step 1: lexical normalization of `.`/`..`. Required so a path with a
    // missing intermediate component can still be matched against the disk.
    let lexical = normalize_lexical(path)
        .ok_or_else(|| AppError::InvalidInput(format!("cannot canonicalize {path:?}")))?;
    // Step 2: if it now exists, resolve symlinks for a stable identity key.
    if lexical.exists() {
        let canon = std::fs::canonicalize(&lexical)
            .map_err(|e| AppError::InvalidInput(format!("canonicalize {lexical:?}: {e}")))?;
        return Ok(normalize_platform(canon));
    }
    // Non-existing path: lexical normalization only (no symlink resolution
    // possible). Callers opening a not-yet-existing file should use
    // `canonicalize_target` instead.
    Ok(normalize_platform(lexical))
}

/// Canonicalize a Save-As target whose parent exists but whose file name may
/// not yet exist on disk (§8.3 step 1).
///
/// Canonicalizes the parent directory (resolving symlinks), then appends the
/// target file name. The parent **must** exist.
pub fn canonicalize_target(parent: &Path, file_name: &str) -> Result<PathBuf> {
    if !parent.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "target parent does not exist or is not a directory: {parent:?}"
        )));
    }
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| AppError::InvalidInput(format!("canonicalize parent {parent:?}: {e}")))?;
    let canon_parent = normalize_platform(canon_parent);
    // Reject empty / path-containing file names — they'd silently create dirs.
    let fname = Path::new(file_name);
    if file_name.is_empty()
        || fname
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir | Component::RootDir))
    {
        return Err(AppError::InvalidInput(format!(
            "invalid file name for Save As target: {file_name:?}"
        )));
    }
    Ok(canon_parent.join(file_name))
}

/// Resolve enough of `candidate` to prove it remains under `base`, including
/// symlinks in any existing path component. Missing trailing components are
/// allowed so callers can validate create/write destinations before they
/// exist. The lexically normalized candidate is returned for the actual I/O.
pub fn ensure_contained_path(base: &Path, candidate: &Path) -> Result<PathBuf> {
    let lexical = normalize_lexical(candidate)
        .ok_or_else(|| AppError::InvalidInput(format!("invalid path: {candidate:?}")))?;
    let resolved_base = canonicalize_with_missing(base)?;
    let resolved_candidate = canonicalize_with_missing(&lexical)?;
    if !resolved_candidate.starts_with(&resolved_base) {
        return Err(AppError::InvalidInput(format!(
            "{candidate:?} escapes allowed root {base:?}"
        )));
    }
    Ok(lexical)
}

/// Canonicalize the deepest existing ancestor, then append any missing tail.
/// This exposes symlink escapes without requiring the final target to exist.
fn canonicalize_with_missing(path: &Path) -> Result<PathBuf> {
    let lexical = normalize_lexical(path)
        .ok_or_else(|| AppError::InvalidInput(format!("invalid path: {path:?}")))?;
    let mut existing = lexical.as_path();
    let mut missing = Vec::new();

    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing.file_name().ok_or_else(|| {
                    AppError::InvalidInput(format!("no existing ancestor for {path:?}"))
                })?;
                missing.push(name.to_os_string());
                existing = existing.parent().ok_or_else(|| {
                    AppError::InvalidInput(format!("no existing ancestor for {path:?}"))
                })?;
            }
            Err(error) => return Err(AppError::Io(error)),
        }
    }

    let mut resolved = normalize_platform(
        std::fs::canonicalize(existing)
            .map_err(|error| AppError::InvalidInput(format!("canonicalize {existing:?}: {error}")))?,
    );
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

/// Lexically normalize `.`/`..` without touching the filesystem. Returns
/// `None` for a relative path with `..` that would escape above the root.
fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    let mut out: Vec<Component<'_>> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => { /* skip `.` */ }
            Component::ParentDir => match out.last() {
                // Pop the last normal component; but if the last is a root
                // prefix (e.g. `/` on Unix, `C:` on Windows), `..` is a no-op.
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => { /* root: ignore `..` */ }
                None => return None, // `..` above a relative root — escaping.
                _ => out.push(comp),
            },
            c => out.push(c),
        }
    }
    let mut buf = PathBuf::new();
    for c in out {
        buf.push(c.as_os_str());
    }
    Some(buf)
}

/// Platform-specific normalization applied on top of `canonicalize`'s output.
///
/// On Windows, `std::fs::canonicalize` returns a `\\?\`-prefixed verbatim UNC
/// path with an upper-case drive letter. We strip the verbatim prefix so the
/// result compares equal to the paths the rest of the app constructs (which do
/// not carry the prefix). Drive-letter casing is already consistent from
/// `canonicalize`, so no further work is needed.
fn normalize_platform(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
        path
    }
    #[cfg(not(windows))]
    {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_for_existing_file_resolves_dotdot() {
        let tmp = std::env::temp_dir();
        let dir = tmp.join(format!("ts-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.typ");
        std::fs::write(&file, "x").unwrap();
        // Reference the same file via `..` to prove normalization happens.
        let via_dotdot = dir.join("sub").join("..").join("a.typ");
        // Compare both canonical forms — they must be equal regardless of how
        // the path was spelled lexically. (`temp_dir()` on macOS is under
        // `/var`, a symlink to `/private/var`, so canonicalization matters.)
        let canon_via_dotdot = canonicalize_for_identity(&via_dotdot).unwrap();
        let canon_direct = canonicalize_for_identity(&file).unwrap();
        assert_eq!(canon_via_dotdot, canon_direct);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_for_symlink_resolves_to_target() {
        let tmp = std::env::temp_dir();
        let dir = tmp.join(format!("ts-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("real.typ");
        std::fs::write(&target, "x").unwrap();
        let link = dir.join("alias.typ");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let via_link = canonicalize_for_identity(&link).unwrap();
            let via_target = canonicalize_for_identity(&target).unwrap();
            assert_eq!(via_link, via_target, "symlink must resolve to target");
        }
        // On platforms without symlink support, this test is a no-op assertion.
        let _ = link;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_canonicalizes_existing_parent() {
        let tmp = std::env::temp_dir();
        let parent = tmp.join(format!("ts-target-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        let canon = canonicalize_target(&parent, "new.typ").unwrap();
        assert_eq!(canon.file_name().and_then(|s| s.to_str()), Some("new.typ"));
        // The file need not exist for the canonical path to be valid.
        assert!(!canon.exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn target_rejects_missing_parent() {
        let bogus = Path::new("/nonexistent-ts-parent-xyz");
        assert!(canonicalize_target(bogus, "x.typ").is_err());
    }

    #[test]
    fn target_rejects_path_components_in_filename() {
        let tmp = std::env::temp_dir();
        let parent = tmp.join(format!("ts-reject-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        assert!(canonicalize_target(&parent, "../escape.typ").is_err());
        assert!(canonicalize_target(&parent, "").is_err());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn lexical_normalizes_curdir() {
        let p = normalize_lexical(Path::new("/a/./b/./c")).unwrap();
        assert_eq!(p, PathBuf::from("/a/b/c"));
    }

    #[test]
    fn lexical_rejects_escape_above_root() {
        // Relative path that escapes above its (relative) root: no absolute
        // anchor to absorb the `..`.
        assert!(normalize_lexical(Path::new("../x")).is_none());
    }

    #[test]
    fn containment_allows_missing_descendant_but_rejects_lexical_escape() {
        let root = std::env::temp_dir().join(format!("ts-contained-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let nested = root.join("new").join("image.png");
        assert_eq!(ensure_contained_path(&root, &nested).unwrap(), nested);
        assert!(ensure_contained_path(&root, &root.join("..").join("escape.png")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn containment_rejects_existing_symlink_to_outside() {
        let root = std::env::temp_dir().join(format!("ts-contained-root-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("ts-contained-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        assert!(ensure_contained_path(&root, &link.join("escape.png")).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
