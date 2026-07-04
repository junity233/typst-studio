//! Session memory: remembers the full editing session across launches,
//! persisted as `session.json` in the app config dir (design spec §13, §16 #8).
//!
//! This is intentionally separate from the settings system — it is opaque
//! program state (not user-facing configuration), read/written via two simple
//! commands. A missing or malformed file degrades to an empty session.
//!
//! ## What is (and isn't) persisted
//!
//! Persisted (§13): the current workspace; every open document (`Disk` file
//! paths + `Untitled` buffer content, in display order); the active view id;
//! and per-document dirty state. Compile results and diagnostics are NOT
//! persisted — they regenerate on startup.
//!
//! ## Tolerant deserialization
//!
//! `session.json` may be written by an older/newer build, or hand-edited. To
//! avoid breaking startup on a malformed entry, deserialization is **tolerant**:
//! - missing fields default to empty (via `#[serde(default)]`);
//! - `openDocuments` that isn't an array deserializes to empty (custom `Vec`
//!   deserializer);
//! - a single record with a missing/wrong-type field is skipped rather than
//!   failing the whole array (custom record deserializer).
//!
//! ## Origin re-derivation on restore
//!
//! The frontend only knows path-vs-untitled (it does not track
//! `WorkspaceFile` vs `LooseFile`). So `OpenDocRecord` stores a single `Disk`
//! variant with just the path; on restore the backend reclassifies the file via
//! the unified open path (`open_from_disk` derives origin from whether a
//! workspace is open + containment, §4.3). This matches the architecture: the
//! origin is a derived classification, not stored state.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;

/// A single open-document entry in the persisted session. The frontend
/// assembles this in display order from its tab list.
///
/// Variants are deliberately coarse (`Disk` vs `Untitled`): the
/// workspace-file vs loose-file distinction is a *derived* classification
/// recomputed on restore (§4.3), so it is not stored. `dirty` is carried so a
/// restore can re-mark a document (for disk files, a dirty record means "you
/// had unsaved edits at shutdown that are now lost" — see the restore path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum OpenDocRecord {
    /// A file backed by a path on disk. On restore it is reopened from disk
    /// (the on-disk bytes; any unsaved edits at shutdown are lost) and marked
    /// dirty if `dirty` is true.
    Disk { path: String, dirty: bool },
    /// An unsaved/untitled buffer. Restored by content (a fresh id is minted —
    /// §13 does not require untitled id stability across restarts).
    Untitled { content: String, dirty: bool },
}

/// What we remember between launches. All fields default so an OLD session.json
/// (with only `lastWorkspace`/`lastFile`) still loads cleanly.
///
/// `rename_all = "camelCase"` so the on-disk shape matches what the frontend
/// sends in a `save_session` patch (`openDocuments`, `activeDocumentId`, …) and
/// what older builds wrote (`lastWorkspace`/`lastFile`). Without it serde would
/// look for snake_case keys and silently drop every camelCase field.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct Session {
    /// Absolute path of the last workspace folder, or "".
    ///
    /// The `alias` lets us read **real legacy `session.json` files** written
    /// by older builds, which serialized in snake_case (no `rename_all` then).
    /// Without it, those files would silently default to "" on upgrade and the
    /// user's remembered workspace would stop reopening.
    #[serde(default, alias = "last_workspace")]
    pub last_workspace: String,
    /// Absolute path of the last file, or "". Kept for backward-compat with
    /// older session.json files; superseded by `open_documents`. Same alias
    /// story as `last_workspace`.
    #[serde(default, alias = "last_file")]
    pub last_file: String,
    /// Every open document, in display (tab) order. See [`OpenDocRecord`].
    #[serde(default, deserialize_with = "deserialize_open_documents")]
    pub open_documents: Vec<OpenDocRecord>,
    /// The active view's document id (as a string). May reference a doc that
    /// fails to restore; the caller falls back to the last successfully opened
    /// view in that case.
    #[serde(default)]
    pub active_document_id: Option<String>,
}

impl OpenDocRecord {
    /// Convenience constructor for a disk file (clean).
    #[cfg(test)]
    pub fn disk(path: impl Into<String>) -> Self {
        Self::Disk { path: path.into(), dirty: false }
    }

    /// Convenience constructor for an untitled buffer (clean).
    #[cfg(test)]
    pub fn untitled(content: impl Into<String>) -> Self {
        Self::Untitled { content: content.into(), dirty: false }
    }

    /// Set the dirty flag (builder-style), returning a new record.
    #[cfg(test)]
    pub fn with_dirty(self, dirty: bool) -> Self {
        match self {
            Self::Disk { path, .. } => Self::Disk { path, dirty },
            Self::Untitled { content, .. } => Self::Untitled { content, dirty },
        }
    }
}

/// Tolerant deserializer for `open_documents`: if the JSON value isn't an array
/// (e.g. a stale string), default to empty instead of failing the whole
/// session. Each element is parsed via [`tolerant_open_doc`] so a single
/// malformed record is skipped, not fatal.
fn deserialize_open_documents<'de, D>(deserializer: D) -> std::result::Result<Vec<OpenDocRecord>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?.unwrap_or(Value::Null);
    let Some(arr) = value.as_array() else {
        // Not an array (or absent) → tolerate as empty.
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        if let Some(rec) = tolerant_open_doc(item) {
            out.push(rec);
        }
        // A malformed element is silently dropped.
    }
    Ok(out)
}

/// Parse one [`OpenDocRecord`] from a JSON value, returning `None` on any
/// shape/type mismatch so a single bad record can't poison the whole session.
fn tolerant_open_doc(value: &Value) -> Option<OpenDocRecord> {
    let obj = value.as_object()?;
    let kind = obj.get("kind")?.as_str()?;
    let dirty = obj
        .get("dirty")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    match kind {
        "disk" => {
            let path = obj.get("path")?.as_str()?.to_string();
            Some(OpenDocRecord::Disk { path, dirty })
        }
        "untitled" => {
            let content = obj
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(OpenDocRecord::Untitled { content, dirty })
        }
        // Unknown variant → drop.
        _ => None,
    }
}

/// Owns the session document behind a lock, persisted to `session.json`.
pub struct SessionService {
    inner: Mutex<Session>,
    path: PathBuf,
}

impl SessionService {
    /// Load the session from `path` (missing/malformed → empty session).
    pub fn load(path: PathBuf) -> Result<Self> {
        let session = if path.exists() {
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            serde_json::from_str::<Session>(&raw).unwrap_or_default()
        } else {
            Session::default()
        };
        Ok(Self { inner: Mutex::new(session), path })
    }

    /// An in-memory empty session rooted at `path` — the startup fallback when
    /// `load` itself fails (§6.5). Never reads from disk; a later successful
    /// `persist` will write to `path`.
    pub fn empty(path: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Session::default()),
            path,
        }
    }

    /// Current snapshot.
    pub fn get(&self) -> Session {
        self.inner.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Merge a partial update into the session, persist it, and return the new
    /// snapshot. The patch is a free-form object (`{ lastWorkspace?,
    /// lastFile?, openDocuments?, activeDocumentId? }`); only the present
    /// fields are applied, and a wrong-type field is skipped (not fatal). The
    /// frontend always sends a full `openDocuments` array + `activeDocumentId`
    /// on capture, replacing the prior values wholesale.
    pub fn update(&self, patch: Value) -> Result<Session> {
        let mut s = self.inner.lock().map_err(|e| {
            crate::error::AppError::Other(format!("session lock: {e}"))
        })?;
        if let Some(obj) = patch.as_object() {
            if let Some(v) = obj.get("lastWorkspace").and_then(|v| v.as_str()) {
                s.last_workspace = v.to_string();
            }
            if let Some(v) = obj.get("lastFile").and_then(|v| v.as_str()) {
                s.last_file = v.to_string();
            }
            // openDocuments: a present array replaces the prior list (tolerant:
            // a non-array value is ignored so the existing list is preserved).
            if let Some(arr) = obj.get("openDocuments").and_then(|v| v.as_array()) {
                let mut docs = Vec::with_capacity(arr.len());
                for item in arr {
                    if let Some(rec) = tolerant_open_doc(item) {
                        docs.push(rec);
                    }
                }
                s.open_documents = docs;
            }
            // activeDocumentId: a string sets it; an explicit null clears it.
            match obj.get("activeDocumentId") {
                Some(Value::Null) => s.active_document_id = None,
                Some(v) if v.is_string() => {
                    s.active_document_id = v.as_str().map(|s| s.to_string());
                }
                _ => {} // missing or wrong type → leave as-is
            }
        }
        let snapshot = s.clone();
        drop(s);
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    fn persist(&self, session: &Session) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write (§5.2): session.json is overwritten in place, so use the
        // temp-file-then-rename protocol to avoid corruption on crash.
        crate::persistence::atomic::write_json(&self.path, session)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_session_json_loads_with_defaults() {
        // A legacy session.json (only lastWorkspace/lastFile) must deserialize
        // cleanly with empty open_documents and no active id.
        let json = r#"{"lastWorkspace":"/x","lastFile":"/y.typ"}"#;
        let s: Session = serde_json::from_str(json).expect("legacy JSON must load");
        assert_eq!(s.last_workspace, "/x");
        assert_eq!(s.last_file, "/y.typ");
        assert!(s.open_documents.is_empty());
        assert_eq!(s.active_document_id, None);
    }

    #[test]
    fn legacy_snake_case_session_json_still_loads() {
        // Older builds wrote session.json with NO rename_all, i.e. snake_case
        // keys. Those on-disk files must still load on upgrade (the alias on
        // each legacy field makes serde accept both shapes). Regression test:
        // without the alias, both fields silently default to "".
        let json = r#"{"last_workspace":"/old/work","last_file":"/old/main.typ"}"#;
        let s: Session = serde_json::from_str(json).expect("legacy snake_case JSON must load");
        assert_eq!(s.last_workspace, "/old/work", "legacy snake_case workspace must survive upgrade");
        assert_eq!(s.last_file, "/old/main.typ", "legacy snake_case last_file must survive upgrade");
        assert!(s.open_documents.is_empty());
    }

    #[test]
    fn empty_json_loads_with_defaults() {
        let s: Session = serde_json::from_str("{}").expect("empty object must load");
        assert_eq!(s.last_workspace, "");
        assert_eq!(s.last_file, "");
        assert!(s.open_documents.is_empty());
        assert_eq!(s.active_document_id, None);
    }

    #[test]
    fn round_trip_full_session() {
        let session = Session {
            last_workspace: "/work".into(),
            last_file: "/work/main.typ".into(),
            open_documents: vec![
                OpenDocRecord::disk("/work/a.typ").with_dirty(true),
                OpenDocRecord::untitled("draft"),
                OpenDocRecord::Disk { path: "/x/b.typ".into(), dirty: false },
            ],
            active_document_id: Some("11111111-1111-1111-1111-111111111111".into()),
        };
        let json = serde_json::to_string(&session).expect("serialize");
        let back: Session = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.last_workspace, "/work");
        assert_eq!(back.last_file, "/work/main.typ");
        assert_eq!(back.active_document_id.as_deref(), Some("11111111-1111-1111-1111-111111111111"));
        // Sanity: each variant round-trips with the right discriminator.
        assert_eq!(back.open_documents.len(), 3);
        assert!(matches!(
            &back.open_documents[0],
            OpenDocRecord::Disk { path, dirty } if path == "/work/a.typ" && *dirty
        ));
        assert!(matches!(
            &back.open_documents[1],
            OpenDocRecord::Untitled { content, dirty }
                if content == "draft" && !*dirty
        ));
    }

    #[test]
    fn malformed_open_documents_falls_back() {
        // openDocuments present but not an array → tolerate as empty.
        let json = r#"{"openDocuments":"not an array"}"#;
        let s: Session = serde_json::from_str(json).expect("malformed field must not fail");
        assert!(s.open_documents.is_empty());

        // A single malformed element is dropped; the rest survive.
        let json = r#"{
            "openDocuments": [
                {"kind":"disk","path":"/a.typ"},
                {"kind":"bogus"},
                {"kind":"untitled","content":"hi"},
                "not even an object",
                {"kind":"disk"}]
        }"#;
        let s: Session = serde_json::from_str(json).expect("mixed array must not fail");
        assert_eq!(s.open_documents.len(), 2);
        assert!(matches!(
            &s.open_documents[0],
            OpenDocRecord::Disk { path, .. } if path == "/a.typ"
        ));
        assert!(matches!(
            &s.open_documents[1],
            OpenDocRecord::Untitled { content, .. } if content == "hi"
        ));
    }

    #[test]
    fn active_document_id_round_trips_and_clears() {
        let json = r#"{"activeDocumentId":"abc-123"}"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.active_document_id.as_deref(), Some("abc-123"));

        // Explicit null clears it.
        let json = r#"{"activeDocumentId":null}"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.active_document_id, None);
    }

    #[test]
    fn update_merges_new_fields() {
        let svc = SessionService {
            inner: Mutex::new(Session::default()),
            // `update` persists after merging, so this must be a real writable
            // path (a fresh temp file, cleaned up at the end of the test).
            path: std::env::temp_dir().join(format!(
                "typst-session-{}.json",
                uuid::Uuid::new_v4()
            )),
        };

        // New fields are merged.
        let patch = serde_json::json!({
            "openDocuments": [
                {"kind":"disk","path":"/a.typ","dirty":true},
                {"kind":"untitled","content":"x"}
            ],
            "activeDocumentId": "doc-1"
        });
        let snap = svc.update(patch).expect("update merges new fields");
        assert_eq!(snap.open_documents.len(), 2);
        assert!(matches!(
            &snap.open_documents[0],
            OpenDocRecord::Disk { path, dirty } if path == "/a.typ" && *dirty
        ));
        assert_eq!(snap.active_document_id.as_deref(), Some("doc-1"));

        // Legacy {lastFile} still works alongside the new schema.
        let snap = svc
            .update(serde_json::json!({ "lastFile": "/legacy.typ" }))
            .expect("legacy patch still works");
        assert_eq!(snap.last_file, "/legacy.typ");
        // The previously-set openDocuments/activeId are preserved (the patch
        // omitted them, so they're left untouched).
        assert_eq!(snap.open_documents.len(), 2);
        assert_eq!(snap.active_document_id.as_deref(), Some("doc-1"));

        // activeDocumentId: null clears it.
        let snap = svc
            .update(serde_json::json!({ "activeDocumentId": null }))
            .expect("null clears active id");
        assert_eq!(snap.active_document_id, None);

        // Tolerant: a non-array openDocuments is ignored (existing list kept).
        let snap = svc
            .update(serde_json::json!({ "openDocuments": "oops" }))
            .expect("non-array is tolerated");
        assert_eq!(snap.open_documents.len(), 2);

        let _ = std::fs::remove_file(&svc.path);
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        Session::export(&cfg).expect("Session exports");
        OpenDocRecord::export(&cfg).expect("OpenDocRecord exports");
    }
}
