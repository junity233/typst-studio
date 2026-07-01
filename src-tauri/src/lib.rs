//! Typst Studio — library entry point.
//!
//! Module layout (see docs/superpowers/specs/):
//! - `domain`          Pure data models (DocumentId, Diagnostic, CompileResult)
//! - `typst_engine`    EditorWorld + compiler + font/source loaders
//! - `render`          Pluggable render pipelines (SVG / PDF / PNG)
//! - `service`         Orchestration (EditorService, CompileScheduler, Export)
//! - `project`         Project / VirtualFs abstractions (MVP stubs)
//! - `languageserver`  LanguageService trait (MVP Noop stub)
//! - `settings`        AppConfig + ConfigStore
//! - `ipc`             Tauri commands, events, AppState
//! - `error`           Unified AppError + Result alias

pub mod domain;
pub mod error;
pub mod ipc;
pub mod languageserver;
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
            use tauri::Manager;

            use crate::ipc::state::{AppState, TauriEmitter};
            use crate::lsp::manager::{LspConfig, LspManager};
            use crate::service::editor_service::{EditorService, Emitter};
            use crate::service::export_service::ExportService;

            // The AppHandle is only available inside `.setup`. We wrap it in a
            // TauriEmitter so the service layer can emit events without a direct
            // Tauri dependency.
            let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter {
                app: app.handle().clone(),
            });
            let editor = Arc::new(EditorService::new(emitter));
            let export = Arc::new(ExportService::new(editor.clone()));

            // Start the LSP manager (spawns tinymist + WebSocket server).
            let lsp_config = LspConfig::default();
            let lsp_manager = tauri::async_runtime::block_on(async {
                LspManager::start(lsp_config).await
            });
            match &lsp_manager {
                Ok(m) => {
                    let status = m.status();
                    tracing::info!("LSP manager started: running={}, available={}, ws_url={}",
                        status.running, status.available, status.ws_url);
                }
                Err(e) => {
                    tracing::warn!("LSP manager failed to start: {e}");
                }
            }
            let lsp = Arc::new(parking_lot::Mutex::new(lsp_manager.ok()));

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
