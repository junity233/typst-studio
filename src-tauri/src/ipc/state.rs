//! `AppState` + the production `Emitter` implementation (`TauriEmitter`).
//!
//! [`AppState`] is the single struct managed by Tauri's `State<>`. It holds the
//! service layer behind `Arc`s so commands can clone handles as needed.
//!
//! [`TauriEmitter`] bridges the service-layer [`Emitter`](crate::service::editor_service::Emitter)
//! trait to Tauri's `AppHandle::emit`, translating domain types into the wire
//! payloads defined in [`crate::ipc::events`].

use std::sync::Arc;

// `tauri::Emitter` provides `AppHandle::emit`; alias to `_` to avoid clashing
// with our own `service::editor_service::Emitter` trait imported below.
use tauri::{AppHandle, Emitter as _};

use crate::domain::diagnostics::Diagnostic;
use crate::domain::document::DocumentId;
use crate::ipc::events::{CompiledPayload, CompileStatus, DiagnosticsPayload, StatusPayload};
use crate::service::editor_service::{EditorService, Emitter};
use crate::service::export_service::ExportService;

/// Production `Emitter` backed by a Tauri `AppHandle`.
///
/// Each call forwards to `app.emit(event, payload)`; failures (e.g. no
/// webview attached yet) are silently dropped — the editor remains usable.
pub struct TauriEmitter {
    pub app: AppHandle,
}

impl Emitter for TauriEmitter {
    fn emit_compiled(&self, id: DocumentId, pages: Vec<String>, duration_ms: u64) {
        let _ = self.app.emit(
            "compiled",
            CompiledPayload {
                id,
                pages,
                duration_ms,
            },
        );
    }

    fn emit_diagnostics(&self, id: DocumentId, diagnostics: Vec<Diagnostic>) {
        let _ = self.app.emit("diagnostics", DiagnosticsPayload { id, diagnostics });
    }

    fn emit_status(&self, id: DocumentId, status: CompileStatus, duration_ms: Option<u64>) {
        let _ = self.app.emit(
            "status",
            StatusPayload {
                id,
                status,
                duration_ms,
            },
        );
    }
}

/// The application state held by Tauri and injected into commands via
/// `State<AppState>`.
pub struct AppState {
    pub editor: Arc<EditorService>,
    pub export: Arc<ExportService>,
}
