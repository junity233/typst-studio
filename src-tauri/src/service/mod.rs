//! Service orchestration layer.
//!
//! Phase 4 (§6.1 / §6.3 / §14) splits the old monolithic `EditorService` into:
//! - [`document_service::DocumentService`] — document identity, buffers,
//!   registry, origin transitions, conflict state (§6.1);
//! - [`compile_service::CompileService`] — per-document compile workers,
//!   scheduling, revision-tagged results, rendering (§6.3);
//! - [`editor_service::EditorService`] — the IPC-facing facade that holds the
//!   two siblings and delegates every method (preserving the command-layer
//!   contract: no signature changes).
//!
//! Both services share the backing state via [`tab_store::TabStore`].

pub mod compile_service;
pub mod compile_supervisor;
pub mod compile_worker;
pub mod document_service;
pub mod editor_service;
pub mod export_service;
pub mod file_routing;
pub mod lsp_service;
pub mod save_coordinator;
pub mod session;
pub mod tab_state;
pub mod theme_service;
pub mod tab_store;
pub mod trash;
pub mod watcher_health;
pub mod workspace_service;
