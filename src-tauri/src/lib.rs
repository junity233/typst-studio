//! Typst Studio — library entry point.
//!
//! Module layout (see docs/superpowers/specs/):
//! - `domain`          Pure data models (DocumentId, Diagnostic, CompileResult, CompileStatus)
//! - `fs`              Workspace filesystem access (FileResolver, file tree, watcher)
//! - `typst_engine`    EditorWorld + compiler + font/source loaders
//! - `render`          Pluggable render pipelines (SVG / PDF / PNG)
//! - `service`         Orchestration (EditorService, CompileScheduler, Export)
//! - `project`         Project abstraction (MVP stub)
//! - `settings`        AppConfig + ConfigStore
//! - `ipc`             Tauri commands, events, AppState
//! - `error`           Unified AppError + Result alias

pub mod domain;
pub mod error;
pub mod fs;
pub mod ipc;
pub mod lsp;
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
        .invoke_handler(tauri::generate_handler![
            ipc::commands::new_tab,
            ipc::commands::open_file,
            ipc::commands::close_tab,
            ipc::commands::update_text,
            ipc::commands::save_file,
            ipc::commands::export_pdf,
            ipc::commands::export_png,
            ipc::commands::get_diagnostics,
            ipc::commands::get_lsp_status,
            ipc::commands::restart_lsp,
        ])
        .setup(|app| {
            use std::sync::Arc;
            use tauri::{Emitter as _, Manager};

            use crate::ipc::state::{AppState, TauriEmitter};
            use crate::lsp::manager::LspConfig;
            use crate::service::editor_service::{EditorService, Emitter};
            use crate::service::export_service::ExportService;
            use crate::service::lsp_service::LspService;

            // The AppHandle is only available inside `.setup`. We wrap it in a
            // TauriEmitter so the service layer can emit events without a direct
            // Tauri dependency.
            let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter {
                app: app.handle().clone(),
            });
            let editor = Arc::new(EditorService::new(emitter));
            let export = Arc::new(ExportService::new(editor.clone()));

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

            app.manage(AppState { editor, export, lsp });

            // Auto-open devtools in debug builds to help diagnose blank screens.
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
