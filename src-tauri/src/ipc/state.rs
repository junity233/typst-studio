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
use crate::domain::document::{ConflictState, DocumentId};
use crate::domain::source_map::LineRect;
use crate::ipc::events::{
    CompiledPayload, CompileStatus, ConflictPayload, DiagnosticsPayload, StatusPayload,
};
use crate::net::client::HttpClient;
use crate::service::editor_service::{EditorService, Emitter};
use crate::service::export_service::ExportService;
use crate::service::lsp_service::LspService;
use crate::service::save_coordinator::SaveCoordinator;
use crate::service::session::SessionService;
use crate::service::workspace_service::WorkspaceService;
use crate::settings::SettingsService;

/// Production `Emitter` backed by a Tauri `AppHandle`.
///
/// Each call forwards to `app.emit(event, payload)`; failures (e.g. no
/// webview attached yet) are silently dropped — the editor remains usable.
pub struct TauriEmitter {
    pub app: AppHandle,
}

impl Emitter for TauriEmitter {
    fn emit_compiled(
        &self,
        id: DocumentId,
        revision: u64,
        pages: Vec<String>,
        line_map: Vec<LineRect>,
        duration_ms: u64,
    ) {
        let _ = self.app.emit(
            "compiled",
            CompiledPayload {
                id,
                revision,
                pages,
                line_map,
                duration_ms,
            },
        );
    }

    fn emit_diagnostics(&self, id: DocumentId, revision: u64, diagnostics: Vec<Diagnostic>) {
        let _ = self.app.emit(
            "diagnostics",
            DiagnosticsPayload { id, revision, diagnostics },
        );
    }

    fn emit_status(
        &self,
        id: DocumentId,
        revision: u64,
        status: CompileStatus,
        duration_ms: Option<u64>,
    ) {
        let _ = self.app.emit(
            "status",
            StatusPayload {
                id,
                revision,
                status,
                duration_ms,
            },
        );
    }

    fn emit_conflict(
        &self,
        id: DocumentId,
        revision: u64,
        conflict: ConflictState,
        disk_content: Option<String>,
    ) {
        let _ = self.app.emit(
            "conflict",
            ConflictPayload {
                id,
                revision,
                conflict,
                disk_content,
            },
        );
    }
}

/// The application state held by Tauri and injected into commands via
/// `State<AppState>`.
pub struct AppState {
    pub editor: Arc<EditorService>,
    pub export: Arc<ExportService>,
    /// LSP service wrapping the tinymist bridge.
    pub lsp: Arc<LspService>,
    /// The open workspace (a folder), its file tree, and watcher.
    pub workspace: Arc<WorkspaceService>,
    /// Dynamic user settings (JSON config + manifest validation).
    pub settings: Arc<SettingsService>,
    /// Last-opened workspace/file memory (separate from settings).
    pub session: Arc<SessionService>,
    /// Reusable HTTP client (paste remote-image fetch + future downloads).
    pub net: Arc<HttpClient>,
    /// Unified save orchestration (§5.3): Save / Save As / Save All under one
    /// coordinator with explicit `SaveState` + the §5.2 atomic-save protocol.
    /// A top-level coordinator (like export/recovery) holding an
    /// `Arc<DocumentService>`.
    pub save: Arc<SaveCoordinator>,
}
