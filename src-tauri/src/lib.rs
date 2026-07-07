//! Typst Studio — library entry point.
//!
//! Module layout (see docs/superpowers/specs/):
//! - `domain`          Pure data models (DocumentId, Diagnostic, CompileResult, CompileStatus)
//! - `fs`              Workspace filesystem access (FileResolver, file tree, watcher)
//! - `typst_engine`    EditorWorld + compiler + font/source loaders
//! - `render`          Pluggable render pipelines (SVG / PDF / PNG)
//! - `service`         Orchestration (EditorService, CompileScheduler, Export)
//! - `project`         Project abstraction (MVP stub)
//! - `settings`        Dynamic JSON config + shared manifest + SettingsService
//! - `ipc`             Tauri commands, events, AppState
//! - `error`           Unified AppError + Result alias

pub mod domain;
pub mod diagnostics;
pub mod error;
pub mod fs;
pub mod git;
pub mod ipc;
pub mod lsp;
pub mod net;
pub mod paths;
pub mod persistence;
pub mod project;
pub mod render;
pub mod service;
pub mod settings;
pub mod startup;
pub mod typst_engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Phase-1 logging (§7.4): a minimal stderr subscriber installed as a
    // thread-local dispatch so errors before `.setup` (font scan, build-context
    // failures) are visible on the console. The guard is held for the whole
    // process; phase-2 (in `.setup`) installs the full rolling-file + stderr
    // layered subscriber as the global default, superseding this one.
    let _early_log_guard = crate::diagnostics::init_early_stderr();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // Single-instance enforcement + .typ file routing (§6.1). Desktop-only —
    // `tauri-plugin-single-instance` has no mobile build, so the registration
    // (and the dependency in Cargo.toml) is gated by the `desktop` cfg. On a
    // second launch the callback forwards the file request to this (existing)
    // instance, which either focuses the already-open view or opens a new tab.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, argv, _cwd| {
            crate::service::file_routing::handle_single_instance(app, argv);
        },
    ));

    builder
        // Native application menu (File/Edit/View/Export/Help). Built once and
        // applied app-wide (macOS menubar; Win/Linux per-window).
        .menu(|app| crate::ipc::menu::build_menu(app))
        .on_menu_event(|app, event| {
            crate::ipc::menu::dispatch_menu_event(app, event.id());
        })
        // Intercept the main window's close (traffic light / Cmd+Q / Alt+F4):
        // never close synchronously — hand the decision to the frontend, which
        // checks for unsaved tabs and either `destroy()`s the window or shows a
        // Save-All / Don't-Save / Cancel dialog. The Settings window (a
        // separate label) is left alone so it closes freely.
        //
        // On blur (focus loss), flush pending recovery snapshots immediately so
        // the user's edits are durable before they switch away (§5.1.2 "窗口
        // 失焦...立即 flush").
        .on_window_event(|window, event| {
            // Only the main window participates in close interception and
            // recovery flushes; the Settings window (and any future secondary
            // window) closes freely and has nothing to recover.
            if window.label() != "main" {
                return;
            }
            use tauri::Manager as _;
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // §5.1.2: flush pending snapshots before the close decision
                    // is handed to the frontend, so even a fast destroy leaves
                    // the dirty buffers recovered.
                    if let Some(state) = window.app_handle().try_state::<crate::ipc::state::AppState>() {
                        state.editor.flush_recovery();
                    }
                    use tauri::Emitter as _;
                    api.prevent_close();
                    let _ = window.app_handle().emit("close_requested", ());
                }
                tauri::WindowEvent::Focused(false) => {
                    // §5.1.2: flush on blur. `try_state` is fine here — on the
                    // very first blur before setup completes, there's nothing
                    // to flush.
                    if let Some(state) = window.app_handle().try_state::<crate::ipc::state::AppState>() {
                        state.editor.flush_recovery();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Document / editor commands.
            ipc::commands::new_tab,
            ipc::commands::open_file,
            ipc::commands::pick_image_file,
            ipc::commands::close_tab,
            ipc::commands::soft_close_tab,
            ipc::commands::reactivate_tab,
            ipc::commands::hard_close_tab,
            ipc::commands::update_text,
            ipc::commands::save_file,
            ipc::commands::save_state,
            ipc::commands::save_all,
            ipc::fs_commands::save_as,
            ipc::commands::export_pdf,
            ipc::commands::export_png,
            ipc::commands::export_svg,
            ipc::commands::get_diagnostics,
            ipc::commands::get_lsp_status,
            ipc::commands::restart_lsp,
            // Workspace / filesystem commands.
            ipc::fs_commands::open_workspace,
            ipc::fs_commands::open_default_workspace,
            ipc::fs_commands::open_workspace_by_path,
            ipc::fs_commands::close_workspace,
            ipc::fs_commands::get_workspace,
            ipc::fs_commands::get_watcher_health,
            ipc::fs_commands::read_dir,
            ipc::fs_commands::search_workspace,
            ipc::fs_commands::create_entry,
            ipc::fs_commands::rename_entry,
            ipc::fs_commands::delete_entry,
            ipc::fs_commands::open_file_by_path,
            ipc::fs_commands::reveal_in_finder,
            // Git (Source Control view, Phase 4).
            ipc::git_commands::git_status,
            ipc::git_commands::git_stage,
            ipc::git_commands::git_unstage,
            ipc::git_commands::git_commit,
            ipc::git_commands::git_log,
            // Settings commands.
            ipc::settings_commands::get_all_settings,
            ipc::settings_commands::get_setting,
            ipc::settings_commands::set_setting,
            ipc::settings_commands::get_settings_manifest,
            ipc::settings_commands::open_settings,
            // Diagnostics (§7.4): open the rolling-log directory.
            ipc::settings_commands::open_log_dir,
            // Open WebView devtools (F12 console) on the main window — lets
            // users self-diagnose in shipped builds.
            ipc::settings_commands::open_devtools,
            // Theme commands (appearance.theme).
            ipc::theme_commands::list_themes,
            ipc::theme_commands::get_theme_css,
            ipc::theme_commands::open_themes_dir,
            // Session memory commands (open documents + active view).
            ipc::session_commands::get_session,
            ipc::session_commands::save_session,
            ipc::session_commands::record_workspace,
            ipc::session_commands::clear_recent_workspaces,
            ipc::session_commands::set_dirty,
            // Crash-recovery commands (§5.1.3 / §5.1.4).
            ipc::recovery_commands::list_recovery,
            ipc::recovery_commands::recover_document,
            ipc::recovery_commands::discard_recovery,
            ipc::recovery_commands::discard_all_recovery,
            ipc::recovery_commands::compare_recovery,
            ipc::recovery_commands::mark_clean_shutdown,
            // Conflict-resolution commands (§5.4).
            ipc::conflict_commands::resolve_conflict_use_disk,
            ipc::conflict_commands::resolve_conflict_overwrite,
            ipc::conflict_commands::clear_conflict,
            // Network: remote image download (paste feature).
            ipc::net_commands::fetch_url_to_file,
            // Packages & templates (Packages view).
            ipc::package_commands::package_list_catalog,
            ipc::package_commands::package_refresh_index,
            ipc::package_commands::package_install,
            ipc::package_commands::package_uninstall,
            ipc::package_commands::package_list_installed,
            ipc::package_commands::package_init_template,
            ipc::package_commands::package_insert_import,
            ipc::package_commands::package_compiler_version,
            ipc::package_commands::package_dir_is_empty,
            ipc::package_commands::package_get_readme,
            ipc::package_commands::package_get_thumbnail,
            // AI Assistant proxy (streaming LLM calls; key injected in Rust).
            ipc::ai_commands::ai_proxy_stream,
        ])
        .setup(|app| {
            use std::sync::Arc;
            use tauri::{Emitter as _, Manager};

            // Phase-2 logging (§7.4): now that an app handle exists, install
            // the full rolling-file + stderr layered subscriber. If it can't
            // initialize (e.g. a test already set a global default), log and
            // continue — logging must never block startup.
            match crate::diagnostics::resolve_log_dir() {
                Ok(log_dir) => {
                    if let Err(errs) = crate::diagnostics::init_full(log_dir) {
                        eprintln!("diagnostics: file subscriber not installed: {errs:?}");
                    }
                }
                Err(e) => eprintln!("diagnostics: log dir unavailable: {e}"),
            }

            // Pre-build the process-wide font store (embedded + system scan +
            // user-configured extra dirs). Moved to AFTER the settings service
            // is constructed so the `compiler.extraFontDirs` setting can fold
            // into the one-time scan; see `warm(extra_dirs)` below. The scan is
            // the dominant cost of opening the first tab (~hundreds of ms on
            // macOS), so it still runs well before any window/tab exists.

            use crate::ipc::state::{AppState, TauriEmitter};
            use crate::lsp::manager::LspConfig;
            use crate::net::client::HttpClient;
            use crate::service::editor_service::{EditorService, Emitter};
            use crate::service::export_service::ExportService;
            use crate::service::lsp_service::LspService;
            use crate::service::session::SessionService;
            use crate::service::workspace_service::WorkspaceService;
            use crate::settings::{JsonFileStore, Manifest, SettingsService};
            use crate::startup::{StartupProblem, StartupProblemsPayload};

            // Non-fatal startup problems (§6.5): collected here, emitted once at
            // the end of setup so the frontend can show a non-modal banner. A
            // single component failure must never prevent the main window.
            let mut startup_problems: Vec<StartupProblem> = Vec::new();

            // The AppHandle is only available inside `.setup`. We wrap it in a
            // TauriEmitter so the service layer can emit events without a direct
            // Tauri dependency.
            let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter {
                app: app.handle().clone(),
            });
            let editor = Arc::new(EditorService::new(emitter));
            let export = Arc::new(ExportService::new(editor.clone()));
            let workspace = Arc::new(WorkspaceService::new());

            // Start the LSP service (spawns tinymist + WebSocket server).
            // The status callback emits a Tauri event on each transition so the
            // frontend can subscribe instead of polling.
            //
            // `block_on` here is intentional: `LspManager::start` does a fast
            // `which` (PATH lookup, ~ms) and a `TcpListener::bind`. Both finish
            // in single-digit milliseconds on a normal PATH, so the brief
            // main-thread block before window creation is preferable to the
            // complexity of a spawn + Arc-swap + placeholder-to-live transition
            // (which would also race the frontend's initial get_lsp_status).
            // If `which` ever becomes slow (huge PATH), move this to a spawned
            // task and swap the service in via an Arc<RwLock<Arc<LspService>>>.
            let lsp_config = LspConfig::default();
            let app_for_lsp = app.handle().clone();
            let lsp = tauri::async_runtime::block_on(async {
                LspService::start(lsp_config, move |status| {
                    use crate::ipc::events::LspStatusPayload;
                    // The manager now produces the richer `LspStatus` directly;
                    // `LspStatusPayload: From<LspStatus>` is the single
                    // field-for-field mapping point, so this closure is a
                    // pass-through.
                    let payload = LspStatusPayload::from(status);
                    let _ = app_for_lsp.emit("lsp_status", payload);
                })
                .await
            });
            let lsp = match lsp {
                Ok(svc) => {
                    let status = svc.status();
                    tracing::info!(
                        "LSP service started: status={:?}, available={}, enabled={}, \
                         generation={}, ws_url={}",
                        status.status, status.available, status.enabled,
                        status.generation, status.ws_url
                    );
                    Arc::new(svc)
                }
                Err(e) => {
                    tracing::warn!("LSP service failed to start: {e}");
                    // Fall back to a no-manager service so the LSP commands still
                    // resolve (reporting unavailable) instead of panicking at setup.
                    Arc::new(LspService::disabled())
                }
            };

            // Settings: persist a free-form JSON document in the platform config
            // dir; broadcast every change to all windows via `settings_changed`.
            // Fault-tolerance (§6.5): if the config dir can't be resolved, fall
            // back to a process-local temp dir; if the settings store fails,
            // fall back to an in-memory default store. Either way the app boots
            // and the failure is collected into `startup_problems` for a banner.
            let cfg_dir = crate::startup::config_dir_or_problem(
                app.path().app_config_dir().map_err(|e| e.to_string()),
                &mut startup_problems,
            );
            // Best-effort: clean up stale atomic-write temp files older than 24h
            // (§5.2). Errors here are not user-visible.
            if let Err(e) = crate::persistence::cleanup_stale_temps(&cfg_dir) {
                tracing::warn!(error = %e, "startup: stale-temp cleanup failed");
            }
            let store = JsonFileStore::new(cfg_dir.join("settings.json"));
            let manifest = Manifest::embedded();
            let app_for_settings = app.handle().clone();
            let settings = Arc::new(crate::startup::load_or_problem(
                "settings",
                || {
                    SettingsService::new(
                        store,
                        manifest,
                        move |data| {
                            let _ = app_for_settings.emit("settings_changed", data.clone());
                        },
                    )
                },
                || {
                    // Fallback: an in-memory default store that never persists.
                    // Uses the same embedded manifest so validation still works.
                    SettingsService::new(
                        JsonFileStore::new(cfg_dir.join("settings.json")),
                        Manifest::embedded(),
                        |_: &serde_json::Value| {},
                    )
                    .expect("in-memory default settings must construct")
                },
                &mut startup_problems,
            ));

            // Now that settings exist, pre-build the process-wide font store
            // folding in the user-configured extra font directories
            // (`compiler.extraFontDirs`). This runs before any window/tab can
            // open, so the system scan cost stays off the first-open path. The
            // store is process-wide; changing extra dirs takes effect on restart.
            {
                let extra_font_dirs = settings
                    .get_or_default::<Vec<String>>("compiler.extraFontDirs")
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>();
                crate::typst_engine::font_loader::warm(&extra_font_dirs);
            }

            // Session memory (open documents + active view, §13) in the same config dir.
            // `SessionService::load` is already load-tolerant (corrupt/missing →
            // empty), but guard the `?` so any future regression degrades
            // instead of aborting. The fallback builds an in-memory empty
            // session at the same path (so a later successful persist works).
            let session_path = cfg_dir.join("session.json");
            let session = Arc::new(crate::startup::load_or_problem(
                "session",
                || SessionService::load(session_path.clone()),
                || SessionService::empty(session_path.clone()),
                &mut startup_problems,
            ));

            // Crash-recovery subsystem (§5.1). Resolved under the same config
            // dir as session/settings. Built AFTER the session is loaded but
            // BEFORE the AppState is managed, so the recovery service is wired
            // into the editor before any tab can be opened.
            //
            // Recovery is fault-tolerant by design: a failure to construct the
            // service (rare — it just creates a dir) degrades to recovery
            // disabled and surfaces a startup problem, never blocking the app.
            let recovery_dir = cfg_dir.join("recovery");
            let recovery = crate::startup::load_or_problem(
                "recovery",
                || crate::persistence::recovery::RecoveryService::new(recovery_dir.clone()),
                || crate::persistence::recovery::RecoveryService::new(std::env::temp_dir().join("typst-studio-recovery-fallback"))
                    .expect("temp-dir fallback recovery service must construct"),
                &mut startup_problems,
            );
            let recovery: Arc<crate::persistence::recovery::RecoveryService> = Arc::new(recovery);
            // §5.1.2: clear the clean-shutdown marker FIRST so a crash during
            // this session is detectable on the next launch. The marker is only
            // re-written once a clean close completes.
            recovery.clear_clean_shutdown();
            // Wire the recovery sink into the editor so update_text/mark_saved
            // snapshot/discard dirty buffers.
            editor.document().set_recovery(recovery.clone());

            // SaveCoordinator (§5.3): unified Save / Save As / Save All with
            // explicit SaveState + the §5.2 atomic protocol. Constructed AFTER
            // the editor (it holds an Arc<DocumentService>) and given the
            // AppHandle so it can emit `save_state_changed` events.
            let save = Arc::new(crate::service::save_coordinator::SaveCoordinator::new(
                editor.document().clone(),
                Some(app.handle().clone()),
            ));

            // Startup recovery detection (§5.1.3). Offer recovery when:
            //   - the prior session did NOT finish a clean shutdown, OR
            //   - a snapshot's revision is newer than what's on disk / in session.
            // Even with a clean marker, a newer-than-disk snapshot is offered.
            // Compute the payload here (synchronously, in setup) and emit it
            // after the window is up so the frontend's listener is registered.
            let recovery_payload = compute_recovery_payload(&recovery);

            // Reusable HTTP client shared app-wide via AppState.
            let net = Arc::new(HttpClient::new());

            // Package service (Packages view): index cache + typst-kit handle.
            // Index/thumbnail caches live under the app config dir (NOT typst's
            // own dirs) so the two tools never disturb each other's state.
            let index_path = cfg_dir.join("cache").join("package-index.json");
            let thumbnail_dir = cfg_dir.join("cache").join("thumbnails");
            let package_index = std::sync::Arc::new(
                crate::fs::package_index::PackageIndex::new(net.clone(), index_path),
            );
            let packages = std::sync::Arc::new(
                crate::service::package_service::PackageService::new(
                    package_index,
                    crate::fs::packages::system_packages(),
                    thumbnail_dir,
                ),
            );

            // User CSS themes (appearance.theme). The themes dir is a sibling of
            // settings.json/session.json under the config dir; the service scans
            // it once at construction and watches it for hot-reload, emitting
            // `themes_changed` on any change. Fault-tolerant like the other
            // services: a missing/unreadable dir just means "no user themes".
            let themes_dir = cfg_dir.join("themes");
            let themes = Arc::new(crate::service::theme_service::ThemeService::new(
                themes_dir,
                app.handle().clone(),
            ));
            themes.start_watcher();

            // §6.3 watcher-health polling fallback. Started from the editor's
            // shared store so the background thread can enumerate open docs and
            // route divergences through the same handle_external_change path
            // the native watcher uses. Active only while there are open docs.
            let watcher_health = Arc::new(
                crate::service::watcher_health::WatcherHealth::start(editor.document().store_clone()),
            );

            app.manage(AppState {
                editor,
                export,
                lsp,
                workspace,
                settings,
                themes,
                session,
                net,
                save,
                watcher_health,
                packages,
            });

            // Custom titlebar (Windows only): drop the OS frame so the frontend
            // can render its own titlebar (logo + File/Edit/View/Help menus +
            // min/max/close). macOS keeps its native traffic-light decoration;
            // Linux keeps its WM frame. Done here (not in tauri.conf.json) so a
            // single config builds identically on all platforms.
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager as _;
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_decorations(false);
                }
            }

            // Emit the recovery-available event (if any) AFTER manage + after a
            // short delay so the frontend's listener (registered on first
            // render) is subscribed. The frontend's useStartupSession waits
            // for this before doing its session restore so recovery wins.
            if let Some(payload) = recovery_payload {
                let app_for_recovery = app.handle().clone();
                // Spawn on the async runtime so we don't block setup; a tiny
                // delay lets the frontend mount its listener.
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let _ = app_for_recovery.emit("recovery_available", payload);
                });
            }

            // Emit any collected startup problems once, so the frontend can show
            // a non-modal banner (§6.5). Empty vec → no event (nothing to show).
            if !startup_problems.is_empty() {
                tracing::warn!(count = startup_problems.len(), "startup problems collected");
                let _ = app.emit(
                    "startup_problems",
                    StartupProblemsPayload { problems: startup_problems },
                );
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // §6.2 "应用关闭时停止接收任务并有界等待 worker 结束": on Exit, signal
            // the compile supervisor to drain (no new compiles, suppress in-flight
            // emits) and give the workers a brief, bounded window to finish their
            // current compile. Best-effort — Rust can't force-kill a thread, so a
            // runaway compile outliving the window is simply dropped. We do this on
            // ExitRequested/Exit, not on every window close, so a Settings-window
            // toggle doesn't tear down compilation.
            use tauri::Manager as _;
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<crate::ipc::state::AppState>() {
                    state.editor.compile().shutdown();
                    // §6.3: stop the watcher-health poll thread too.
                    state.watcher_health.shutdown();
                }
            }
        });
}

/// Compute the startup recovery payload (§5.1.3), or `None` when no recovery is
/// offered.
///
/// Recovery is offered when:
/// - the prior session did NOT finish a clean shutdown (no `clean-shutdown`
///   marker) and at least one snapshot exists; OR
/// - even WITH a clean marker, some snapshot's content differs from the disk
///   file now (the snapshot captured edits that never made it to disk).
///
/// When offered, the payload lists every snapshot with a per-doc `disk_changed`
/// flag so the UI can pick the right default action (§5.1.3).
fn compute_recovery_payload(
    recovery: &crate::persistence::recovery::RecoveryService,
) -> Option<crate::ipc::events::RecoveryAvailablePayload> {
    use crate::ipc::events::RecoveryAvailablePayload;
    use crate::ipc::recovery_commands::summarize_recoverable;

    let snapshots = recovery.list_recoverable();
    if snapshots.is_empty() {
        return None;
    }
    let infos = summarize_recoverable(&snapshots);
    if infos.is_empty() {
        return None;
    }
    // §5.1.3 decision: offer if not clean, OR any snapshot is disk-changed
    // (snapshot has edits beyond what's on disk — offer even after a clean
    // shutdown, since the user may want that buffer back).
    let any_disk_changed = infos.iter().any(|i| i.disk_changed);
    if recovery.has_clean_shutdown() && !any_disk_changed {
        // Clean shutdown and every snapshot matches disk → nothing to recover.
        return None;
    }
    Some(RecoveryAvailablePayload { snapshots: infos })
}
