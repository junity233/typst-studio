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
pub mod error;
pub mod fs;
pub mod ipc;
pub mod lsp;
pub mod net;
pub mod project;
pub mod render;
pub mod service;
pub mod settings;
pub mod typst_engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing for structured logging.
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    use tauri::{Emitter as _, Manager as _};
                    api.prevent_close();
                    let _ = window.app_handle().emit("close_requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Document / editor commands.
            ipc::commands::new_tab,
            ipc::commands::open_file,
            ipc::commands::close_tab,
            ipc::commands::update_text,
            ipc::commands::save_file,
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
            ipc::fs_commands::read_dir,
            ipc::fs_commands::create_entry,
            ipc::fs_commands::rename_entry,
            ipc::fs_commands::delete_entry,
            ipc::fs_commands::open_file_by_path,
            ipc::fs_commands::reveal_in_finder,
            // Settings commands.
            ipc::settings_commands::get_all_settings,
            ipc::settings_commands::get_setting,
            ipc::settings_commands::set_setting,
            ipc::settings_commands::get_settings_manifest,
            ipc::settings_commands::open_settings,
            // Session memory commands (last workspace + file).
            ipc::session_commands::get_session,
            ipc::session_commands::save_session,
            // Network: remote image download (paste feature).
            ipc::net_commands::fetch_url_to_file,
        ])
        .setup(|app| {
            use std::sync::Arc;
            use tauri::{Emitter as _, Manager};

            // Pre-build the process-wide font store (embedded + system scan).
            // The scan is the dominant cost of opening the first tab (~hundreds
            // of ms on macOS); warming it here — during LSP startup, before any
            // window/tab exists — moves that cost off the first-open path.
            crate::typst_engine::font_loader::warm();

            use crate::ipc::state::{AppState, TauriEmitter};
            use crate::lsp::manager::LspConfig;
            use crate::net::client::HttpClient;
            use crate::service::editor_service::{EditorService, Emitter};
            use crate::service::export_service::ExportService;
            use crate::service::lsp_service::LspService;
            use crate::service::session::SessionService;
            use crate::service::workspace_service::WorkspaceService;
            use crate::settings::{JsonFileStore, Manifest, SettingsService};

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
                    let payload = LspStatusPayload {
                        running: status.running,
                        ws_url: status.ws_url,
                        available: status.available,
                    };
                    let _ = app_for_lsp.emit("lsp_status", payload);
                })
                .await
            });
            let lsp = match lsp {
                Ok(svc) => {
                    let status = svc.status();
                    tracing::info!("LSP service started: running={}, available={}, ws_url={}",
                        status.running, status.available, status.ws_url);
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
            // `app_config_dir()?` + `SettingsService::new(...)?` both convert
            // into the setup closure's `Box<dyn std::error::Error>` return.
            let cfg_dir = app.path().app_config_dir()?;
            let store = JsonFileStore::new(cfg_dir.join("settings.json"));
            let manifest = Manifest::embedded();
            let app_for_settings = app.handle().clone();
            let settings = Arc::new(SettingsService::new(
                store,
                manifest,
                move |data| {
                    let _ = app_for_settings.emit("settings_changed", data.clone());
                },
            )?);

            // Session memory (last workspace + file) in the same config dir.
            let session = Arc::new(SessionService::load(cfg_dir.join("session.json"))?);

            // Reusable HTTP client shared app-wide via AppState.
            let net = Arc::new(HttpClient::new());

            app.manage(AppState { editor, export, lsp, workspace, settings, session, net });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
