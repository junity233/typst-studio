//! Crash-recovery IPC commands (§5.1.3 / §5.1.4).
//!
//! Thin adapters over the [`RecoveryService`](crate::persistence::recovery::RecoveryService)
//! reached via `AppState.editor.recovery()`. The startup detection + event
//! emission lives in `lib.rs` `.setup` (it needs the `AppHandle` before any
//! command can run); these commands cover the in-dialog actions:
//!
//! - `list_recovery` — re-fetch the recoverable list (the dialog already got it
//!   via the `recovery_available` event, but this lets it refresh).
//! - `recover_document(id)` — load one snapshot's content for an in-memory
//!   rebuild (does NOT write disk).
//! - `discard_recovery(id)` — drop one snapshot (the "Don't Save" path).
//! - `discard_all_recovery()` — drop every snapshot (the dialog's "Discard All").
//! - `compare_recovery(id)` — load both the snapshot content AND the current
//!   disk content so the UI can show a side-by-side diff.

use tauri::State;

use crate::domain::disk_version::DiskVersion;
use crate::error::{AppError, Result};
use crate::ipc::events::{RecoverableInfo, RecoveredDocument};
use crate::ipc::state::AppState;

/// Recompute the recoverable list (§5.1.3). Each entry carries `disk_changed`,
/// computed by comparing the snapshot's recorded disk version against the file
/// on disk now. Returns an empty vec when no snapshots exist.
#[tauri::command]
pub async fn list_recovery(state: State<'_, AppState>) -> Result<Vec<RecoverableInfo>> {
    let Some(recovery) = state.editor.recovery() else {
        return Ok(Vec::new());
    };
    Ok(summarize_recoverable(&recovery.list_recoverable()))
}

/// Load one snapshot for an in-memory document rebuild (§5.1.3). Does NOT
/// write disk — recovery creates a dirty in-memory doc. Errors if the snapshot
/// is absent/corrupt.
#[tauri::command]
pub async fn recover_document(
    state: State<'_, AppState>,
    id: String,
) -> Result<RecoveredDocument> {
    let recovery = state
        .editor
        .recovery()
        .ok_or_else(|| AppError::NotFound("recovery service not wired".into()))?;
    let snap = recovery
        .load_snapshot(&id)
        .ok_or_else(|| AppError::NotFound(format!("no recovery snapshot for {id}")))?;
    Ok(RecoveredDocument {
        document_id: snap.document_id,
        content: snap.content,
        title: snap.title,
        canonical_path: snap.canonical_path,
        origin: snap.origin,
    })
}

/// Delete one recovery snapshot (§5.1.4 "Don't Save"). No-op if the snapshot is
/// already gone. Idempotent.
#[tauri::command]
pub async fn discard_recovery(state: State<'_, AppState>, id: String) -> Result<()> {
    let Some(recovery) = state.editor.recovery() else {
        return Ok(());
    };
    // The id is the document-id string the snapshot was keyed on. If it fails
    // to parse (shouldn't happen for ids we minted), fall back to a fresh id —
    // `discard_snapshot` for a non-existent id is a harmless no-op.
    let doc_id = parse_doc_id(&id).unwrap_or_default();
    recovery.discard_snapshot(doc_id);
    Ok(())
}

/// Delete ALL recovery snapshots (the dialog's "Discard All"). Idempotent.
#[tauri::command]
pub async fn discard_all_recovery(state: State<'_, AppState>) -> Result<()> {
    if let Some(recovery) = state.editor.recovery() {
        recovery.clear_all();
    }
    Ok(())
}

/// Write the clean-shutdown marker (§5.1.2). Called by the frontend's close
/// guard immediately before `window.destroy()`, AFTER all dirty docs have been
/// saved or explicitly discarded. The marker is what the next launch checks to
/// decide whether to offer recovery; writing it here means "this session ended
/// cleanly, no recovery needed next time" (unless a newer-than-disk snapshot
/// still exists, which is checked separately at startup).
#[tauri::command]
pub async fn mark_clean_shutdown(state: State<'_, AppState>) -> Result<()> {
    // Flush any pending debounced snapshots first so the marker reflects the
    // true final state (a pending edit that hasn't flushed would otherwise be
    // lost + the marker would claim a clean shutdown).
    state.editor.flush_recovery();
    if let Some(recovery) = state.editor.recovery() {
        recovery.mark_clean_shutdown();
    }
    Ok(())
}

/// Load both the snapshot content and the current disk content for a doc, so
/// the UI can show a read-only side-by-side compare (§5.1.3 "比较"). `disk` is
/// `None` when the file is missing or has no canonical path (Untitled).
///
/// Returned as a tuple-serialized object `{ snapshot, disk }`.
#[tauri::command]
pub async fn compare_recovery(
    state: State<'_, AppState>,
    id: String,
) -> Result<CompareRecovery> {
    let recovery = state
        .editor
        .recovery()
        .ok_or_else(|| AppError::NotFound("recovery service not wired".into()))?;
    let snap = recovery
        .load_snapshot(&id)
        .ok_or_else(|| AppError::NotFound(format!("no recovery snapshot for {id}")))?;
    let disk = snap
        .canonical_path
        .as_deref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    Ok(CompareRecovery {
        snapshot: snap.content,
        disk,
    })
}

/// Result of `compare_recovery`: the snapshot buffer + the current disk content
/// (or `None` if the file is gone).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CompareRecovery {
    pub snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk: Option<String>,
}

// --- helpers ----------------------------------------------------------------

/// Build the IPC payload list from loaded snapshots, computing `disk_changed`
/// per snapshot (§5.1.3): a snapshot is "disk changed" iff its recorded disk
/// version differs from the file's current version, OR the file is missing,
/// OR the snapshot had no disk version to begin with (an untitled doc always
/// counts as "unchanged" — there's no disk to compare).
pub(crate) fn summarize_recoverable(
    snapshots: &[crate::persistence::recovery::RecoverySnapshot],
) -> Vec<RecoverableInfo> {
    snapshots
        .iter()
        .map(|s| {
            let disk_changed = match (&s.disk_version, &s.canonical_path) {
                (Some(recorded), Some(path)) => match DiskVersion::from_path(std::path::Path::new(path)) {
                    Ok(current) => current != *recorded,
                    // File missing on disk now → changed (it's gone).
                    Err(_) => true,
                },
                // No recorded disk version but a path: can't compare → treat as
                // unchanged (the snapshot predates disk-version tagging).
                (None, Some(_)) => false,
                // Untitled: no disk, never "changed".
                (_, None) => false,
            };
            RecoverableInfo {
                document_id: s.document_id.clone(),
                title: s.title.clone(),
                canonical_path: s.canonical_path.clone(),
                captured_at: s.captured_at,
                disk_changed,
            }
        })
        .collect()
}

/// Best-effort parse of a document-id string back into a `DocumentId`. The
/// snapshot's document_id is the stringified uuid of the original document;
/// recovery discards key on that id.
fn parse_doc_id(s: &str) -> Option<crate::domain::document::DocumentId> {
    uuid::Uuid::parse_str(s).ok().map(crate::domain::document::DocumentId)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::recovery::RecoverySnapshot;

    fn snap(id: &str, path: Option<&str>, dv: Option<DiskVersion>) -> RecoverySnapshot {
        RecoverySnapshot {
            schema_version: 1,
            document_id: id.into(),
            origin: "loose".into(),
            canonical_path: path.map(String::from),
            title: "t".into(),
            content: "c".into(),
            revision: 1,
            disk_version: dv,
            captured_at: 0,
            app_version: "0".into(),
        }
    }

    #[test]
    fn summarize_marks_disk_changed_when_bytes_differ() {
        // Snapshot recorded disk version A; the on-disk file is version B → changed.
        let dir = std::env::temp_dir().join(format!("ts-rec-sum-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.typ");
        std::fs::write(&p, "ON DISK NOW").unwrap();
        let now = DiskVersion::from_path(&p).unwrap();
        let stale = DiskVersion::from_bytes(b"old content");
        let path = p.to_string_lossy().to_string();
        let snaps = vec![snap("a", Some(&path), Some(stale))];
        let out = summarize_recoverable(&snaps);
        assert!(out[0].disk_changed, "differing disk → changed");

        // When the recorded version equals the current → unchanged.
        let snaps2 = vec![snap("a", Some(&path), Some(now))];
        let out2 = summarize_recoverable(&snaps2);
        assert!(!out2[0].disk_changed, "matching disk → unchanged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summarize_missing_file_is_changed() {
        let stale = DiskVersion::from_bytes(b"x");
        let snaps = vec![snap("a", Some("/nonexistent/ts-xyz/f.typ"), Some(stale))];
        let out = summarize_recoverable(&snaps);
        assert!(out[0].disk_changed, "missing file → changed");
    }

    #[test]
    fn summarize_untitled_is_unchanged() {
        let snaps = vec![snap("a", None, None)];
        let out = summarize_recoverable(&snaps);
        assert!(!out[0].disk_changed, "untitled → unchanged");
    }
}
