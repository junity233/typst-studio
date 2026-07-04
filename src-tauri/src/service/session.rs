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
use crate::persistence::migrate::Migrator;
use crate::persistence::{load_json_with_backup, write_with_backup, LoadOutcome};

/// The current Session schema version (§7.3). Bump when the on-disk shape
/// changes, and add a step to [`session_migrator`].
///
/// Version history:
/// - **v0**: no `schemaVersion` field (written by pre-versioning batches).
/// - **v1**: the original shape — `lastWorkspace` / `lastFile` /
///   `openDocuments` / `activeDocumentId`.
/// - **v2** (§7.2): adds window bounds, layout state (sidebar/preview/
///   diagnostics visibility + pane widths), and `recentWorkspaces`. The v2
///   fields are all additive + `#[serde(default)]`, so a v1 file loads and the
///   v1→v2 step is a pure version bump (no transform needed). v0 and v1 files
///   migrate up to v2 transparently.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Build the Session [`Migrator`] (§7.3).
///
/// - v0 → v1: **no-op** — the v1 shape is the union of the v0 fields, so a
///   pre-versioning file already matches once its absent `schemaVersion`
///   deserializes as 0.
/// - v1 → v2: **additive no-op** — the v2 fields (`windowBounds`, `layout`,
///   `recentWorkspaces`) are all `Option`/Vec with `#[serde(default)]`, so a v1
///   value already deserializes as a valid v2 value (the new fields default to
///   `None`/empty). The step exists purely to advance the version tag.
///
/// Migrations run on a clone (clone-then-commit), so a failing step can never
/// corrupt the loaded session; the caller logs and keeps the value as-is.
/// §7.3 "新版本无法识别时进入兼容降级，不覆盖原文件": a value claiming a version
/// NEWER than current is left untouched (the migrator returns its claimed
/// version without rewriting), so a future-build session loads with degradation
/// and is never silently downgraded/overwritten.
pub fn session_migrator() -> Migrator<Session> {
    Migrator::new(CURRENT_SCHEMA_VERSION)
        // v0 → v1: no-op (the v1 shape is a superset of v0).
        .step(|_| Ok(()))
        // v1 → v2: additive (new fields default); advance the version tag only.
        .step(migrate_v1_to_v2)
}

/// v1 → v2 migration step (§7.3, §7.2). The v2 fields are additive and
/// `#[serde(default)]`, so a v1 value already deserializes into a valid v2
/// shape with the new fields defaulted. The only work is to (optionally) seed
/// `recent_workspaces` from the legacy `window.recentWorkspaces` settings list
/// if the caller stuffed one into the session as a migration hint — but the
/// canonical source migration (settings → session) happens in the frontend's
/// capture path, not here. So this step is effectively a no-op that exists to
/// document the bump and to be the future home of any real transform.
fn migrate_v1_to_v2(_s: &mut Session) -> Result<()> {
    Ok(())
}

/// Persisted window geometry + chrome state (§7.2 "窗口大小、位置、最大化和全屏
/// 状态"). Restored on startup and clamped to the current monitor's work area
/// (a saved position from a now-removed external monitor must not reopen the
/// window off-screen). All fields are tolerated on load via `#[serde(default)]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct WindowBounds {
    /// Inner (client-area) width in px.
    #[serde(default)]
    pub width: u32,
    /// Inner (client-area) height in px.
    #[serde(default)]
    pub height: u32,
    /// Outer x (px from the monitor's left). `None` ⇒ center on restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    /// Outer y (px from the monitor's top). `None` ⇒ center on restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

/// Persisted UI-panel layout (§7.2 "侧栏、诊断面板与预览可见性；分栏尺寸").
/// These migrate the per-first-run defaults out of `window.*` settings into
/// the session (settings remain as a fallback default for a brand-new install).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct LayoutState {
    #[serde(default)]
    pub sidebar_visible: bool,
    #[serde(default)]
    pub preview_visible: bool,
    #[serde(default)]
    pub diagnostics_visible: bool,
    /// Sidebar pane width (px), if a custom size was captured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<f64>,
    /// Preview pane width (px), if a custom size was captured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_width: Option<f64>,
}

impl Default for LayoutState {
    /// The first-run layout matches the long-standing `window.*` setting
    /// defaults (sidebar on, preview on, diagnostics collapsed/visible), so a
    /// fresh install looks identical to before.
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            preview_visible: true,
            diagnostics_visible: false,
            sidebar_width: None,
            preview_width: None,
        }
    }
}

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct Session {
    /// Session schema version (§7.3). Defaults to the current version on
    /// fresh writes; on load, an absent field deserializes to `0` (treated as
    /// "version unknown / pre-versioning") and is migrated up to
    /// [`CURRENT_SCHEMA_VERSION`] by [`session_migrator`] before use. The
    /// frontend never needs to send this — it's a backend-managed tag.
    #[serde(default)]
    pub schema_version: u32,
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
    // --- v2 fields (§7.2) — all additive + #[serde(default)] so a v0/v1 file
    //     loads cleanly with these defaulted to None/empty. ---
    /// Window geometry + chrome (§7.2). `None` until the frontend captures it
    /// on the first close; restored (clamped to the monitor) on the next start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<WindowBounds>,
    /// UI-panel layout (§7.2). `None` for a v1 file; the frontend falls back to
    /// the `window.*` settings defaults (or [`LayoutState::default`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<LayoutState>,
    /// Recently-opened workspace paths (§7.2 "最近工作区"), most-recent-first.
    /// Mirrored from the legacy `window.recentWorkspaces` setting so the
    /// welcome/switch-workspace UI can read it from the session. Deduplicated +
    /// capped at [`MAX_RECENT_WORKSPACES`] on update.
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
}

/// Maximum number of recent-workspace entries kept in the session (§7.2). Old
/// entries are trimmed on update so the list can't grow unbounded.
pub const MAX_RECENT_WORKSPACES: usize = 10;

impl Default for Session {
    /// A freshly-constructed Session starts at the **current** schema version
    /// (so a new install persists `schemaVersion: <current>`). This is distinct
    /// from deserialization, where an *absent* `schemaVersion` field (an old
    /// file) yields `0` via `#[serde(default)]` and is migrated up on load.
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            last_workspace: String::new(),
            last_file: String::new(),
            open_documents: Vec::new(),
            active_document_id: None,
            window_bounds: None,
            layout: None,
            recent_workspaces: Vec::new(),
        }
    }
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

/// Deduplicate a list of strings, keeping the FIRST occurrence of each (so the
/// most-recent-first ordering the caller sends is preserved). Case-sensitive —
/// paths are canonicalized by the caller before recording.
fn dedupe_preserve_order(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter().filter(|s| seen.insert(s.clone())).collect()
}
pub struct SessionService {
    inner: Mutex<Session>,
    path: PathBuf,
}

impl SessionService {
    /// Load the session from `path` with `.bak` fallback + schema migration
    /// (§5.2, §7.3). A missing file, a corrupt main WITH a usable `.bak`, or a
    /// corrupt main WITHOUT a `.bak` all degrade gracefully — the app always
    /// boots. See [`crate::persistence::load_json_with_backup`] for the
    /// recovery semantics and [`session_migrator`] for the version model.
    pub fn load(path: PathBuf) -> Result<Self> {
        let mut session = load_session_with_backup(&path)?;
        // Run any pending migrations (§7.3). v0 → v1 is a no-op today; the
        // hook is here for future bumps. On failure we keep the loaded value
        // as-is and log (§7.3: don't corrupt; degrade compatibly). The
        // migrated form is persisted on the next successful save.
        let migrator = session_migrator();
        if let Err(e) = migrator.migrate(
            &mut session,
            |s| s.schema_version,
            |s, v| s.schema_version = v,
        ) {
            tracing::warn!(
                ?path, error = %e,
                "session: migration failed; using loaded value as-is (file left untouched)",
            );
        }
        Ok(Self {
            inner: Mutex::new(session),
            path,
        })
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

    /// Record that the user opened `workspace` (§7.2 "最近工作区"): bump it to
    /// the front of `recent_workspaces`, dedupe, and cap at
    /// [`MAX_RECENT_WORKSPACES`]. An empty path clears the current workspace
    /// marker but does NOT touch the recent list. Persists + returns the new
    /// snapshot. Best-effort: a persist failure is returned as `Err` (the
    /// caller logs; the in-memory list is still updated).
    pub fn record_workspace(&self, workspace: &str) -> Result<Session> {
        let mut s = self.inner.lock().map_err(|e| {
            crate::error::AppError::Other(format!("session lock: {e}"))
        })?;
        if workspace.is_empty() {
            s.last_workspace = String::new();
        } else {
            // Move-to-front: remove any existing entry, then prepend.
            s.recent_workspaces.retain(|w| w != workspace);
            s.recent_workspaces.insert(0, workspace.to_string());
            s.recent_workspaces.truncate(MAX_RECENT_WORKSPACES);
            s.last_workspace = workspace.to_string();
        }
        let snapshot = s.clone();
        drop(s);
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Clear the recent-workspaces list (§9 "清除最近记录"). Persists + returns
    /// the new snapshot.
    pub fn clear_recent_workspaces(&self) -> Result<Session> {
        let mut s = self.inner.lock().map_err(|e| {
            crate::error::AppError::Other(format!("session lock: {e}"))
        })?;
        s.recent_workspaces.clear();
        let snapshot = s.clone();
        drop(s);
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Clear ALL recovery snapshots via the injected clearer (§9 "清除最近记录
    /// 时可选择同时清除恢复数据"). This is the bridge from the session/settings
    /// layer to the recovery store; the caller passes `recovery.clear_all`
    /// (kept as a closure so this module doesn't depend on the recovery crate).
    /// Recovery clearing is best-effort and logged, not fatal — the recent-list
    /// clear (the primary action) still succeeds.
    pub fn clear_recent_and_recovery<F>(&self, clear_recovery: F) -> Result<Session>
    where
        F: FnOnce(),
    {
        // Run the recovery clear first; a failure there (it logs internally)
        // must not block the recent-list clear that the user actually asked for.
        clear_recovery();
        self.clear_recent_workspaces()
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
            // --- v2 fields (§7.2) ---
            // windowBounds: an object replaces the prior bounds; an explicit
            // null clears it. A wrong-type value is ignored.
            match obj.get("windowBounds") {
                Some(Value::Null) => s.window_bounds = None,
                Some(v) if v.is_object() => {
                    if let Ok(b) = serde_json::from_value::<WindowBounds>(v.clone()) {
                        s.window_bounds = Some(b);
                    }
                }
                _ => {}
            }
            // layout: an object replaces the prior layout; null clears it.
            match obj.get("layout") {
                Some(Value::Null) => s.layout = None,
                Some(v) if v.is_object() => {
                    if let Ok(l) = serde_json::from_value::<LayoutState>(v.clone()) {
                        s.layout = Some(l);
                    }
                }
                _ => {}
            }
            // recentWorkspaces: a present array REPLACES the list. An explicit
            // null/empty clears it. The frontend typically sends the full,
            // most-recent-first list on every workspace-open; we dedupe + cap
            // defensively so the on-disk shape stays bounded regardless of what
            // the caller sends.
            if let Some(arr) = obj.get("recentWorkspaces").and_then(|v| v.as_array()) {
                let mut ws: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                ws = dedupe_preserve_order(ws);
                ws.truncate(MAX_RECENT_WORKSPACES);
                s.recent_workspaces = ws;
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
        // Serialize once; both the atomic main write and the `.bak` rotation
        // reuse these bytes (§5.2: write_with_backup rotates the previous
        // known-good into session.json.bak).
        let bytes = serde_json::to_vec_pretty(session)?;
        write_with_backup(&self.path, &bytes)?;
        Ok(())
    }
}

/// Load a [`Session`] from `path` using the `.bak`-fallback helper (§5.2).
///
/// - Primary load → the parsed session.
/// - Restored from `.bak` → the backup's parsed session (the corrupt main was
///   quarantined to `*.corrupt-<ts>.json` by the helper; we log the path).
/// - Missing/unrecoverable → [`Session::default`] (a fresh, empty, current-
///   version session).
fn load_session_with_backup(path: &std::path::Path) -> Result<Session> {
    let outcome =
        load_json_with_backup(path, |s: &str| serde_json::from_str::<Session>(s))?;
    match outcome {
        LoadOutcome::Primary(s) => Ok(s),
        LoadOutcome::RestoredFromBackup { value, corrupt_path } => {
            tracing::warn!(
                ?path, ?corrupt_path,
                "session: main file was corrupt; restored from .bak (corrupt copy preserved)",
            );
            Ok(value)
        }
        LoadOutcome::MissingOrUnrecoverable => {
            // Brand-new install, or both files gone/corrupt. Start fresh.
            tracing::debug!(
                ?path,
                "session: no loadable session (missing or unrecoverable); starting empty",
            );
            Ok(Session::default())
        }
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
        // An absent schemaVersion field deserializes to 0 (pre-versioning);
        // the load path migrates it up to current.
        assert_eq!(s.schema_version, 0, "absent schemaVersion must deserialize as 0");
        assert_eq!(s.last_workspace, "");
        assert_eq!(s.last_file, "");
        assert!(s.open_documents.is_empty());
        assert_eq!(s.active_document_id, None);
    }

    #[test]
    fn default_session_is_at_current_schema_version() {
        // A freshly-defaulted in-memory session (new install / fallback) is at
        // the current version, NOT 0 — so its first persist writes the right
        // tag. (Deserialization is the only path that yields 0.)
        let s = Session::default();
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn round_trip_full_session() {
        let session = Session {
            schema_version: CURRENT_SCHEMA_VERSION,
            last_workspace: "/work".into(),
            last_file: "/work/main.typ".into(),
            open_documents: vec![
                OpenDocRecord::disk("/work/a.typ").with_dirty(true),
                OpenDocRecord::untitled("draft"),
                OpenDocRecord::Disk { path: "/x/b.typ".into(), dirty: false },
            ],
            active_document_id: Some("11111111-1111-1111-1111-111111111111".into()),
            // v2 fields round-trip too.
            window_bounds: Some(WindowBounds {
                width: 1400,
                height: 900,
                x: Some(100),
                y: Some(50),
                maximized: false,
                fullscreen: false,
            }),
            layout: Some(LayoutState {
                sidebar_visible: false,
                preview_visible: true,
                diagnostics_visible: true,
                sidebar_width: Some(240.0),
                preview_width: None,
            }),
            recent_workspaces: vec!["/work".into(), "/other".into()],
        };
        let json = serde_json::to_string(&session).expect("serialize");
        let back: Session = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
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
        // v2 fields survive the round trip.
        let wb = back.window_bounds.expect("window_bounds round-trip");
        assert_eq!((wb.width, wb.height), (1400, 900));
        assert_eq!(wb.x, Some(100));
        let layout = back.layout.expect("layout round-trip");
        assert!(!layout.sidebar_visible);
        assert_eq!(layout.sidebar_width, Some(240.0));
        assert_eq!(back.recent_workspaces, vec!["/work".to_string(), "/other".to_string()]);
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

    /// Canonicalized temp dir for load/persist integration tests (macOS
    /// `/var` → `/private/var`).
    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-session-it-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::domain::path::canonicalize_for_identity(&dir)
            .unwrap_or_else(|_| dir.canonicalize().unwrap_or(dir))
    }

    #[test]
    fn load_migrates_v0_session_to_current() {
        // A session.json written by a prior batch (no schemaVersion) must
        // load, migrate v0 → v1 (no-op), and report the current version — all
        // without losing the persisted workspace/docs.
        let dir = tmp_dir();
        let path = dir.join("session.json");
        std::fs::write(
            &path,
            r#"{"lastWorkspace":"/w","openDocuments":[{"kind":"disk","path":"/w/a.typ","dirty":true}]}"#,
        )
        .unwrap();

        let svc = SessionService::load(path).expect("v0 session must load");
        let s = svc.get();
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION, "v0 must migrate to current");
        assert_eq!(s.last_workspace, "/w", "data must survive migration");
        assert_eq!(s.open_documents.len(), 1);
    }

    #[test]
    fn load_missing_file_starts_empty_at_current_version() {
        let dir = tmp_dir();
        let path = dir.join("nope-session.json");
        let svc = SessionService::load(path).expect("missing session must not error");
        let s = svc.get();
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(s.open_documents.is_empty());
    }

    #[test]
    fn load_corrupt_main_falls_back_to_bak() {
        // Write a good .bak, garbage main; load must restore from .bak and
        // quarantine the corrupt main.
        let dir = tmp_dir();
        let path = dir.join("session.json");
        let bak = path.with_extension("json.bak");
        std::fs::write(&bak, r#"{"lastWorkspace":"/from-bak"}"#).unwrap();
        std::fs::write(&path, "{ totally broken").unwrap();

        let svc = SessionService::load(path.clone()).expect("corrupt main must fall back to .bak");
        let s = svc.get();
        assert_eq!(s.last_workspace, "/from-bak", "should have restored the .bak content");
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION, "restored session migrates to current");

        // The corrupt main should have been renamed aside (.corrupt-*).
        assert!(!path.exists(), "corrupt main must have been moved away");
        let quarantined = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("session.corrupt-")
            });
        assert!(quarantined.is_some(), "corrupt main should have been quarantined");
    }

    #[test]
    fn persist_rotates_previous_into_bak() {
        // load → update (persist) → update (persist) leaves a .bak with the
        // first persisted shape.
        let dir = tmp_dir();
        let path = dir.join("session.json");
        let bak = path.with_extension("json.bak");

        let svc = SessionService::load(path.clone()).unwrap();
        // First persist: main only, no .bak yet.
        svc.update(serde_json::json!({ "lastFile": "/first.typ" })).unwrap();
        assert!(path.exists());
        assert!(!bak.exists(), "first persist should not yet produce a .bak");

        // Second persist: main = second, .bak = first.
        svc.update(serde_json::json!({ "lastFile": "/second.typ" })).unwrap();
        let main = std::fs::read_to_string(&path).unwrap();
        let bak_content = std::fs::read_to_string(&bak).unwrap();
        assert!(main.contains("/second.typ"), "main must hold the latest write");
        assert!(bak_content.contains("/first.typ"), ".bak must hold the previous write");

        // Reload from the main and confirm the value survived.
        let svc2 = SessionService::load(path).unwrap();
        assert_eq!(svc2.get().last_file, "/second.typ");
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        Session::export(&cfg).expect("Session exports");
        OpenDocRecord::export(&cfg).expect("OpenDocRecord exports");
        WindowBounds::export(&cfg).expect("WindowBounds exports");
        LayoutState::export(&cfg).expect("LayoutState exports");
    }

    // --- S20/S21: Session v2 + migration tests ------------------------------

    #[test]
    fn v1_session_fixture_migrates_to_v2() {
        // A REAL v1 session.json (schemaVersion: 1, no v2 fields) must migrate
        // up to v2 on load, with the new additive fields defaulted. This is the
        // §11.6 "旧 schema fixture 可逐级迁移" v1→v2 leg.
        let dir = tmp_dir();
        let path = dir.join("session.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"lastWorkspace":"/w",
                "openDocuments":[{"kind":"disk","path":"/w/a.typ","dirty":false}],
                "activeDocumentId":"abc"}"#,
        )
        .unwrap();

        let svc = SessionService::load(path).expect("v1 fixture must load");
        let s = svc.get();
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION, "v1 must migrate to v2");
        // v1 data survives.
        assert_eq!(s.last_workspace, "/w");
        assert_eq!(s.open_documents.len(), 1);
        assert_eq!(s.active_document_id.as_deref(), Some("abc"));
        // v2 fields are defaulted (additive — absent in the v1 file).
        assert_eq!(s.window_bounds, None, "v1 file has no windowBounds → None");
        assert_eq!(s.layout, None, "v1 file has no layout → None");
        assert!(s.recent_workspaces.is_empty(), "v1 file has no recentWorkspaces");
    }

    #[test]
    fn migrator_runs_v0_v1_v2_chain() {
        // §11.6 "旧 schema fixture 可逐级迁移": a v0 file (no schemaVersion at
        // all) migrates through every step up to current (v2), preserving data.
        let mut s: Session =
            serde_json::from_str(r#"{"lastWorkspace":"/w","lastFile":"/m.typ"}"#).unwrap();
        assert_eq!(s.schema_version, 0, "absent schemaVersion → 0 (v0)");

        let m = session_migrator();
        let reached = m
            .migrate(&mut s, |s| s.schema_version, |s, v| s.schema_version = v)
            .expect("v0→v1→v2 chain must succeed");
        assert_eq!(reached, CURRENT_SCHEMA_VERSION);
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION);
        // All v0 data preserved across the chain.
        assert_eq!(s.last_workspace, "/w");
        assert_eq!(s.last_file, "/m.typ");
    }

    #[test]
    fn unrecognized_future_version_does_not_downgrade() {
        // §11.6 "更新版本无法识别时不覆盖原文件": a session claiming v99 (a
        // future build) must NOT be migrated/downgraded. The migrator returns
        // its claimed version without running any forward step, so the value is
        // left as-is. The "no overwrite" guarantee comes from clone-then-commit
        // + the load path only persisting on the NEXT successful save (a value
        // the migrator declines to touch is never rewritten by the load itself).
        let mut s = Session {
            schema_version: 99,
            last_workspace: "/future".into(),
            ..Default::default()
        };
        let m = session_migrator();
        let reached = m
            .migrate(&mut s, |s| s.schema_version, |s, v| s.schema_version = v)
            .expect("ahead-of-current must not error");
        assert_eq!(reached, 99, "claimed version returned as-is");
        assert_eq!(s.schema_version, 99, "version NOT downgraded");
        assert_eq!(s.last_workspace, "/future", "data untouched");
    }

    #[test]
    fn unrecognized_future_version_file_not_overwritten_on_load() {
        // §11.6 "更新版本无法识别时不覆盖原文件": when a v99 file is loaded, the
        // on-disk bytes must remain intact (the load does not rewrite a file it
        // can't fully understand). We load, then re-read the raw file and assert
        // the version tag is still 99.
        let dir = tmp_dir();
        let path = dir.join("session.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":99,"lastWorkspace":"/future",
                "openDocuments":[{"kind":"disk","path":"/f.typ","dirty":false}]}"#,
        )
        .unwrap();

        let svc = SessionService::load(path.clone()).expect("v99 file must load (degraded)");
        let s = svc.get();
        // Loaded with degradation: version preserved, data intact.
        assert_eq!(s.schema_version, 99);
        assert_eq!(s.last_workspace, "/future");

        // The file on disk is byte-identical (no rewrite happened on load).
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"schemaVersion\":99"), "on-disk file must NOT be overwritten");
    }

    #[test]
    fn update_merges_v2_fields() {
        let svc = SessionService {
            inner: Mutex::new(Session::default()),
            path: std::env::temp_dir().join(format!("typst-session-v2-{}.json", uuid::Uuid::new_v4())),
        };

        // windowBounds + layout + recentWorkspaces all merge in one patch.
        let snap = svc
            .update(serde_json::json!({
                "windowBounds": { "width": 1400, "height": 900, "x": 10, "y": 20, "maximized": false, "fullscreen": false },
                "layout": { "sidebarVisible": true, "previewVisible": false, "diagnosticsVisible": true },
                "recentWorkspaces": ["/a", "/b", "/a"]
            }))
            .expect("v2 patch merges");
        let wb = snap.window_bounds.expect("windowBounds set");
        assert_eq!((wb.width, wb.height), (1400, 900));
        assert_eq!(wb.x, Some(10));
        let layout = snap.layout.expect("layout set");
        assert!(layout.sidebar_visible);
        assert!(!layout.preview_visible);
        // Dedup preserves order: ["/a","/b","/a"] → ["/a","/b"].
        assert_eq!(snap.recent_workspaces, vec!["/a".to_string(), "/b".to_string()]);

        // windowBounds: null clears it.
        let snap = svc
            .update(serde_json::json!({ "windowBounds": null }))
            .expect("null clears windowBounds");
        assert_eq!(snap.window_bounds, None);
        // layout survives (untouched by the windowBounds patch).
        assert!(snap.layout.is_some());

        // Tolerant: a non-object windowBounds is ignored (existing kept).
        let snap = svc
            .update(serde_json::json!({ "windowBounds": "oops" }))
            .expect("non-object windowBounds tolerated");
        assert_eq!(snap.window_bounds, None, "still None (was cleared above)");

        let _ = std::fs::remove_file(&svc.path);
    }

    #[test]
    fn record_workspace_moves_to_front_dedupes_and_caps() {
        let svc = SessionService {
            inner: Mutex::new(Session::default()),
            path: std::env::temp_dir().join(format!("typst-session-rec-{}.json", uuid::Uuid::new_v4())),
        };

        let snap = svc.record_workspace("/a").expect("record /a");
        assert_eq!(snap.recent_workspaces, vec!["/a".to_string()]);
        assert_eq!(snap.last_workspace, "/a");

        // /b → [/b, /a].
        let snap = svc.record_workspace("/b").expect("record /b");
        assert_eq!(snap.recent_workspaces, vec!["/b".to_string(), "/a".to_string()]);

        // /a again → moves to front, dedupe → [/a, /b].
        let snap = svc.record_workspace("/a").expect("record /a again");
        assert_eq!(snap.recent_workspaces, vec!["/a".to_string(), "/b".to_string()]);

        // Cap at MAX_RECENT_WORKSPACES: push (MAX+3) distinct, keep the latest MAX.
        for i in 0..(MAX_RECENT_WORKSPACES + 3) {
            let _ = svc.record_workspace(&format!("/w{i}")).expect("record");
        }
        let snap = svc.get();
        assert_eq!(snap.recent_workspaces.len(), MAX_RECENT_WORKSPACES);
        // Most-recent-first: the last-recorded entry is at the front.
        let last_idx = MAX_RECENT_WORKSPACES + 3 - 1;
        assert_eq!(snap.recent_workspaces[0], format!("/w{last_idx}"));

        // Empty path clears last_workspace but NOT the recent list.
        let snap = svc.record_workspace("").expect("clear current ws");
        assert_eq!(snap.last_workspace, "");
        assert_eq!(snap.recent_workspaces.len(), MAX_RECENT_WORKSPACES);

        let _ = std::fs::remove_file(&svc.path);
    }

    #[test]
    fn clear_recent_and_recovery_invokes_callback_then_clears() {
        let svc = SessionService {
            inner: Mutex::new(Session {
                recent_workspaces: vec!["/a".into(), "/b".into()],
                ..Default::default()
            }),
            path: std::env::temp_dir().join(format!("typst-session-clr-{}.json", uuid::Uuid::new_v4())),
        };
        let mut cleared = false;
        let snap = svc
            .clear_recent_and_recovery(|| { cleared = true; })
            .expect("clear ok");
        assert!(cleared, "recovery callback must run");
        assert!(snap.recent_workspaces.is_empty(), "recent list cleared");
        let _ = std::fs::remove_file(&svc.path);
    }

    #[test]
    fn layout_state_default_matches_first_run_panels() {
        // The first-run layout defaults to sidebar+preview visible, diagnostics
        // hidden — matching the long-standing window.* setting defaults.
        let l = LayoutState::default();
        assert!(l.sidebar_visible);
        assert!(l.preview_visible);
        assert!(!l.diagnostics_visible);
    }

    #[test]
    fn v2_session_with_partial_window_bounds_loads() {
        // A v2 file with a minimal windowBounds (only w/h) must load; the
        // absent x/y/maximized/fullscreen default.
        let json = r#"{"schemaVersion":2,"windowBounds":{"width":1000,"height":700}}"#;
        let s: Session = serde_json::from_str(json).expect("partial windowBounds loads");
        let wb = s.window_bounds.expect("windowBounds present");
        assert_eq!((wb.width, wb.height), (1000, 700));
        assert_eq!(wb.x, None);
        assert_eq!(wb.y, None);
        assert!(!wb.maximized);
        assert!(!wb.fullscreen);
    }
}
