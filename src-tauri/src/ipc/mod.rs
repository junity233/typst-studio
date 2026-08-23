//! IPC layer — thin Tauri command/event wrappers.
//!
//! Commands intentionally only do parameter conversion and delegate to services.

pub mod commands;
pub mod dialog;
pub mod ai_commands;
pub mod bib_commands;
pub mod conflict_commands;
pub mod error;
pub mod events;
pub mod formula_commands;
pub mod fs_commands;
pub mod git_commands;
pub mod menu;
pub mod menu_labels;
pub mod net_commands;
pub mod package_commands;
pub mod project_config_commands;
pub mod recovery_commands;
pub mod session_commands;
pub mod settings_commands;
pub mod theme_commands;
pub mod state;

use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;

/// Shared containment guard for app-initiated writes whose destination the
/// frontend computes (pasted images: `write_bytes_to_file`,
/// `fetch_url_to_file`). `dest` must be an absolute path under the open
/// workspace root or the app config dir — the only two legitimate targets for
/// a pasted image — so a compromised/XSSed frontend can't write to `~/.ssh/`,
/// a sibling document, or any arbitrary absolute path. Containment resolves
/// every existing ancestor, so a symlinked directory can't redirect the write
/// outside an allow-listed root. Returns the parsed path on success.
pub(crate) fn ensure_paste_dest<'a>(state: &AppState, dest: &'a str) -> Result<&'a Path> {
    let dest_path = Path::new(dest);
    if !dest_path.is_absolute() {
        return Err(AppError::InvalidInput("dest must be absolute".into()));
    }
    let workspace_root = state.workspace.root();
    let config_base = crate::paths::app_config_dir();
    let allowed = workspace_root
        .as_ref()
        .map(|r| crate::domain::path::ensure_contained_path(r, dest_path).is_ok())
        .unwrap_or(false)
        || config_base
            .as_ref()
            .map(|b| crate::domain::path::ensure_contained_path(b, dest_path).is_ok())
            .unwrap_or(false);
    if !allowed {
        return Err(AppError::InvalidInput(
            "dest must be inside the workspace or the app config directory".into(),
        ));
    }
    Ok(dest_path)
}

/// Shared containment guard for app-initiated READS whose path the frontend
/// computes (`read_file_bytes`, the bibliography parse/save family). The same
/// threat model as [`ensure_paste_dest`] — a compromised webview must not be
/// able to exfiltrate arbitrary files — with two extra legitimate origins:
///
/// - an OPEN DOCUMENT's path (image/PDF tabs preview whatever the user opened,
///   which may live anywhere on disk);
/// - the most recent DIALOG-PICKED path (Insert Image reads bytes for the file
///   the user just chose in the native picker). The backend records that path
///   itself in [`pick_image_file`](crate::ipc::commands::pick_image_file), so
///   the webview can never mint an authorization — it can only consume one.
pub(crate) fn ensure_read_source(state: &AppState, source: &str) -> Result<PathBuf> {
    let source_path = Path::new(source);
    if !source_path.is_absolute() {
        return Err(AppError::InvalidInput("path must be absolute".into()));
    }
    let contained = |base: &Path| {
        crate::domain::path::ensure_contained_path(base, source_path).is_ok()
    };
    // An exact open-document match is allowed regardless of containment (the
    // user may have opened a file from anywhere via the open dialog).
    let is_open_doc = state
        .editor
        .document()
        .list_tabs()
        .iter()
        .any(|meta| meta.path.as_deref() == Some(source_path));
    let workspace_root = state.workspace.root();
    let config_base = crate::paths::app_config_dir();
    let dialog_grant = state
        .dialog_grant
        .lock()
        .expect("dialog_grant mutex poisoned")
        .clone();
    let allowed = is_open_doc
        || dialog_grant.as_deref() == Some(source)
        || workspace_root.as_deref().map(contained).unwrap_or(false)
        || config_base.as_deref().map(contained).unwrap_or(false);
    if !allowed {
        return Err(AppError::InvalidInput(
            "path must be an open document, inside the workspace, inside the \
             app config directory, or recently picked via a native dialog"
                .into(),
        ));
    }
    Ok(source_path.to_path_buf())
}

/// Containment guard for [`open_file_by_path`](crate::ipc::fs_commands::open_file_by_path)
/// — the IPC command that reads a file's TEXT into the webview by absolute
/// path. Without it that command is an arbitrary-file-read primitive for a
/// compromised webview (`read_file_bytes` has been guarded since its
/// introduction; this command predates the convention and was missed).
///
/// Everything [`ensure_read_source`] accepts is accepted here (workspace,
/// config dir, an open document's own path, the dialog grant), plus exactly
/// two more backend-minted origins the open flow legitimately needs:
///
/// - a path recorded in the backend-owned `session.json` (`open_documents` /
///   `last_file` / recent workspaces) — session restore reopens those on
///   startup; the webview only ever reads them back from us;
/// - the `open_grant`: the single-instance callback mints it right before
///   emitting `open_external_file`, so a double-clicked file outside every
///   root still opens.
pub(crate) fn ensure_open_source(state: &AppState, source: &str) -> Result<PathBuf> {
    // Backend-owned session memory: any disk path the previous session had
    // open (or the last loose file) may be restored. Cheap: the session is
    // already in memory; no extra IO.
    let session = state.session.get();
    let in_session = !session.last_file.is_empty() && session.last_file == source
        || session
            .open_documents
            .iter()
            .any(|rec| matches!(rec, crate::service::session::OpenDocRecord::Disk { path, .. } if path == source))
        // The single-instance routing grant (minted by handle_single_instance
        // immediately before the event reaches the frontend).
        || state
            .open_grant
            .lock()
            .expect("open_grant mutex poisoned")
            .as_deref()
            == Some(source);
    if in_session {
        return Ok(PathBuf::from(source));
    }
    ensure_read_source(state, source)
}

#[cfg(test)]
pub(crate) mod read_source_tests {
    use super::*;
    use std::sync::Arc;

    use crate::fs::watcher::OnChange;
    use crate::service::editor_service::EditorService;
    use crate::service::export_service::ExportService;
    use crate::service::lsp_service::LspService;
    use crate::service::package_service::PackageService;
    use crate::service::project_config_service::ProjectConfigService;
    use crate::service::save_coordinator::SaveCoordinator;
    use crate::service::session::SessionService;
    use crate::service::theme_service::ThemeService;
    use crate::service::watcher_health::WatcherHealth;
    use crate::service::workspace_service::WorkspaceService;

    /// A minimal AppState for the guard tests: only `workspace`, `editor`, and
    /// `dialog_grant` are consulted; every other service is a default/empty
    /// construction.
    pub(crate) fn test_state() -> AppState {
        let emitter = Arc::new(crate::service::test_support::NoopEmitter);
        let editor = Arc::new(EditorService::new(emitter));
        let net = Arc::new(crate::net::client::HttpClient::new());
        let settings = Arc::new(
            crate::settings::SettingsService::new(
                crate::settings::store::JsonFileStore::new(
                    std::env::temp_dir()
                        .join(format!("typst-guard-{}.json", uuid::Uuid::new_v4())),
                ),
                crate::settings::Manifest::embedded(),
                |_: &serde_json::Value| {},
            )
            .expect("test settings service"),
        );
        AppState {
            export: Arc::new(ExportService::new(editor.clone())),
            lsp: Arc::new(LspService::disabled()),
            save: Arc::new(SaveCoordinator::new(editor.document().clone(), None)),
            session: Arc::new(SessionService::empty(std::env::temp_dir().join(
                format!("typst-guard-session-{}.json", uuid::Uuid::new_v4()),
            ))),
            themes: Arc::new(ThemeService::new_for_test(
                std::env::temp_dir().join("typst-guard-themes"),
            )),
            watcher_health: Arc::new(WatcherHealth::start(editor.document().store_clone())),
            packages: Arc::new(PackageService::new(
                Arc::new(crate::fs::package_index::PackageIndex::new(
                    net.clone(),
                    std::env::temp_dir()
                        .join(format!("typst-guard-index-{}.json", uuid::Uuid::new_v4())),
                )),
                crate::fs::packages::system_packages(),
            )),
            project_config: Arc::new(ProjectConfigService::new(|_| {})),
            tinymist: {
                // Handle-less installer: the guard under test never touches
                // it, and a real AppHandle needs the tauri `test` feature.
                let client = reqwest::Client::builder().build().expect("test reqwest client");
                Arc::new(crate::lsp::installer::TinymistInstaller::with_client(
                    client, None,
                ))
            },
            editor,
            workspace: Arc::new(WorkspaceService::new()),
            settings,
            net,
            dialog_grant: Arc::new(std::sync::Mutex::new(None)),
            open_grant: Arc::new(std::sync::Mutex::new(None)),
            startup_problems: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    pub(crate) fn open_ws_at(state: &AppState, dir: &Path) {
        let on_change: OnChange = Arc::new(|_: &[std::path::PathBuf]| {});
        state
            .workspace
            .open(
                dir.to_path_buf(),
                std::time::Duration::from_millis(300),
                on_change,
                None,
            )
            .unwrap();
    }

    #[test]
    fn rejects_absolute_path_outside_every_root() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        open_ws_at(&state, dir.path());
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();
        let err = ensure_read_source(&state, &secret.to_string_lossy()).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[test]
    fn allows_path_inside_open_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        open_ws_at(&state, dir.path());
        let inner = dir.path().join("biblio.bib");
        std::fs::write(&inner, "@book{k}").unwrap();
        assert!(ensure_read_source(&state, &inner.to_string_lossy()).is_ok());
    }

    #[test]
    fn rejects_relative_path() {
        let state = test_state();
        let err = ensure_read_source(&state, "relative/path.txt").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn allows_the_recorded_dialog_grant_exactly_and_no_sibling() {
        let state = test_state();
        let outside = tempfile::tempdir().unwrap();
        let picked = outside.path().join("photo.png");
        std::fs::write(&picked, "bytes").unwrap();
        // Before any grant: rejected.
        assert!(ensure_read_source(&state, &picked.to_string_lossy()).is_err());
        // The backend records the grant (as pick_image_file does).
        *state.dialog_grant.lock().unwrap() =
            Some(picked.to_string_lossy().into_owned());
        assert!(ensure_read_source(&state, &picked.to_string_lossy()).is_ok());
        // A DIFFERENT path in the same directory is still rejected — the grant
        // is exact-match, not prefix/directory-wide.
        let sibling = outside.path().join("other.png");
        assert!(ensure_read_source(&state, &sibling.to_string_lossy()).is_err());
    }

    #[test]
    fn allows_an_open_document_path_outside_contained_roots() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        open_ws_at(&state, dir.path());
        // Open an untitled doc, then rebind it to an OUTSIDE path (the Save As
        // flow does exactly this) so list_tabs reports that absolute path.
        let meta = state.editor.document().new_tab(None);
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("sheet.pdf");
        std::fs::write(&target, b"%PDF").unwrap();
        state
            .editor
            .document()
            .rebind_path(meta.id, target.clone())
            .unwrap();
        assert!(ensure_read_source(&state, &target.to_string_lossy()).is_ok());
    }

    #[test]
    fn open_guard_rejects_arbitrary_outside_path() {
        let state = test_state();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();
        let err =
            crate::ipc::ensure_open_source(&state, &secret.to_string_lossy())
                .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[test]
    fn open_guard_admits_session_recorded_disk_path_only() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        let restored = dir.path().join("restored.typ");
        std::fs::write(&restored, "#set page(width: 1cm)").unwrap();
        let path_str = restored.to_string_lossy().into_owned();
        // Not recorded yet → rejected (the arbitrary-read primitive stays shut).
        assert!(crate::ipc::ensure_open_source(&state, &path_str).is_err());
        // Record it as the session's open document (session restore flow).
        let s = crate::service::session::Session {
            open_documents: vec![crate::service::session::OpenDocRecord::Disk {
                path: path_str.clone(),
                dirty: false,
            }],
            ..crate::service::session::Session::default()
        };
        state.session.set_for_test(s);
        assert!(crate::ipc::ensure_open_source(&state, &path_str).is_ok());
        // A sibling path NOT in the session is still rejected — the admission
        // is exact-match on recorded paths, not directory-wide.
        let sibling = dir.path().join("other.typ");
        std::fs::write(&sibling, "x").unwrap();
        assert!(crate::ipc::ensure_open_source(
            &state,
            &sibling.to_string_lossy()
        )
        .is_err());
    }

    #[test]
    fn open_guard_admits_last_file_and_single_instance_grant() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        let last = dir.path().join("last.typ");
        std::fs::write(&last, "x").unwrap();
        let last_str = last.to_string_lossy().into_owned();
        // `last_file` (legacy single-file restore) is admitted…
        let s = crate::service::session::Session {
            last_file: last_str.clone(),
            ..crate::service::session::Session::default()
        };
        state.session.set_for_test(s);
        assert!(crate::ipc::ensure_open_source(&state, &last_str).is_ok());

        // …and the single-instance grant is minted by the backend only.
        let dropped = tempfile::tempdir().unwrap();
        let dbl = dropped.path().join("double-clicked.typ");
        std::fs::write(&dbl, "x").unwrap();
        let dbl_str = dbl.to_string_lossy().into_owned();
        assert!(crate::ipc::ensure_open_source(&state, &dbl_str).is_err());
        *state.open_grant.lock().unwrap() = Some(dbl_str.clone());
        assert!(crate::ipc::ensure_open_source(&state, &dbl_str).is_ok());
        let sibling = dropped.path().join("sibling.typ");
        std::fs::write(&sibling, "x").unwrap();
        assert!(crate::ipc::ensure_open_source(
            &state,
            &sibling.to_string_lossy()
        )
        .is_err());
    }
}
