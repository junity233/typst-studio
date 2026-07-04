//! Single-instance file routing (§6.1).
//!
//! When a second app instance launches (or the user double-clicks a `.typ`
//! file while the app is already running), the single-instance plugin forwards
//! the request to the existing instance. This module decides what to do with
//! it: focus the already-open view, or open a fresh tab.
//!
//! The decision logic is extracted into the pure [`route_external_request`]
//! function so it can be unit-tested without spinning up a real second
//! process; the plugin callback ([`handle_single_instance`]) is a thin wrapper
//! that resolves the path, calls the pure function, and emits the matching
//! Tauri event + focuses the window.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::domain::document::DocumentId;
use crate::domain::registry::{DocumentRegistry, SharedRegistry};
use crate::error::{AppError, Result};

/// Outcome of routing an external open-file request (§6.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutingDecision {
    /// The document is already open — the frontend should activate its tab.
    FocusExisting(DocumentId),
    /// The document is not open — the frontend should open a new tab at `path`.
    OpenNew(PathBuf),
}

/// Pure routing decision. Given a canonicalized path and a snapshot of the
/// registry, decide whether to focus an existing view or open a new document.
///
/// Callers are expected to canonicalize the path first (so two lexical
/// variants of the same file route to the same view — see
/// [`canonicalize_for_identity`](crate::domain::path::canonicalize_for_identity)).
pub fn route_external_request(canon: &Path, registry: &DocumentRegistry) -> RoutingDecision {
    match registry.find_by_canonical(canon) {
        Some(id) => RoutingDecision::FocusExisting(id),
        None => RoutingDecision::OpenNew(canon.to_path_buf()),
    }

}

/// Convenience wrapper over a `SharedRegistry` (the form held by
/// [`EditorService`](crate::service::editor_service::EditorService)).
pub fn route_external_request_shared(canon: &Path, registry: &SharedRegistry) -> RoutingDecision {
    route_external_request(canon, &registry.read())
}

/// Handle a single-instance callback: extract the file path from `argv`,
/// canonicalize, route it, emit the matching event, and focus the main window.
///
/// `argv[0]` is the program path; a `.typ` argument may appear at any later
/// position. The first `.typ` argument wins (matches the most common
/// double-click scenario of a single file).
pub fn handle_single_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>) {
    if let Some(file) = extract_typ_arg(&argv) {
        match resolve_and_route(app, &file) {
            Ok(RoutingDecision::FocusExisting(id)) => {
                tracing::info!(?file, ?id, "single-instance: focusing existing view");
                let _ = app.emit("focus_view", FocusViewPayload { id });
            }
            Ok(RoutingDecision::OpenNew(path)) => {
                tracing::info!(open_path = ?path, "single-instance: opening new document");
                let _ = app.emit("open_external_file", OpenExternalFilePayload {
                    path: path.to_string_lossy().into_owned(),
                });
            }
            Err(e) => {
                tracing::warn!(?file, error = %e, "single-instance: routing failed");
            }
        }
    }
    // Always bring the main window forward.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Resolve `file` to a canonical path (best-effort: fall back to the raw path
/// if canonicalization fails because the file vanished) and apply the routing
/// decision against the app's registry.
fn resolve_and_route<R: Runtime>(app: &AppHandle<R>, file: &str) -> Result<RoutingDecision> {
    let path = PathBuf::from(file);
    // Canonicalize so the registry match is identity-based, not lexical. If the
    // file doesn't exist (race), fall back to the raw path — routing then
    // yields OpenNew and the frontend's openFileByPath will report the error.
    let canon = crate::domain::path::canonicalize_for_identity(&path).unwrap_or(path);
    let registry = match app.try_state::<crate::ipc::state::AppState>() {
        Some(state) => state.editor.registry().clone(),
        None => {
            // AppState not yet managed (callback fired before setup finished —
            // shouldn't happen with the single-instance plugin, but be safe).
            return Err(AppError::Other(
                "AppState not available for single-instance routing".into(),
            ));
        }
    };
    Ok(route_external_request_shared(&canon, &registry))
}

/// Find the first `.typ` argument in an argv vector. Returns the raw string
/// (not yet canonicalized). Used both by the live callback and tests.
pub(crate) fn extract_typ_arg(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find(|a| {
        Path::new(a)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("typ"))
            .unwrap_or(false)
    }).cloned()
}

/// Payload of the `focus_view` event (§6.1): the frontend activates the tab
/// for `id`. Reuses the existing DocumentId type so it is already on the wire.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct FocusViewPayload {
    pub id: DocumentId,
}

/// Payload of the `open_external_file` event (§6.1): the frontend opens a new
/// tab at the absolute `path` via the existing `openFileByPath` flow.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct OpenExternalFilePayload {
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::document::{DocumentMeta, WorkspaceId};
    use std::path::PathBuf;

    fn make_meta(id: DocumentId, path: &str) -> DocumentMeta {
        DocumentMeta::with_workspace_path(id, PathBuf::from(path), WorkspaceId::new())
    }

    #[test]
    fn routes_to_focus_when_already_open() {
        let mut reg = DocumentRegistry::new();
        let id = DocumentId::new();
        reg.register(make_meta(id, "/tmp/open.typ")).unwrap();
        let canon = Path::new("/tmp/open.typ");
        assert_eq!(route_external_request(canon, &reg), RoutingDecision::FocusExisting(id));
    }

    #[test]
    fn routes_to_open_new_when_not_open() {
        let reg = DocumentRegistry::new();
        let canon = Path::new("/tmp/brand-new.typ");
        let decision = route_external_request(canon, &reg);
        assert_eq!(decision, RoutingDecision::OpenNew(PathBuf::from("/tmp/brand-new.typ")));
    }

    #[test]
    fn extract_typ_picks_first_typ_argument() {
        let argv = vec![
            "/Applications/Typst Studio.app/Contents/MacOS/typst-studio".to_string(),
            "/Users/x/notes.typ".to_string(),
            "/Users/x/other.md".to_string(),
        ];
        assert_eq!(extract_typ_arg(&argv).as_deref(), Some("/Users/x/notes.typ"));
    }

    #[test]
    fn extract_typ_case_insensitive_extension() {
        let argv = vec!["prog".to_string(), "/x/Y.TYP".to_string()];
        assert_eq!(extract_typ_arg(&argv).as_deref(), Some("/x/Y.TYP"));
    }

    #[test]
    fn extract_typ_none_when_no_typ() {
        let argv = vec!["prog".to_string(), "/x/readme.md".to_string()];
        assert!(extract_typ_arg(&argv).is_none());
    }

    #[test]
    fn extract_typ_none_for_lone_program() {
        let argv = vec!["prog".to_string()];
        assert!(extract_typ_arg(&argv).is_none());
    }
}
