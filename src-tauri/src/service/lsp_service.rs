//! `LspService` — thin orchestration wrapper around [`LspManager`].
//!
//! Mirrors the service-layer pattern of [`crate::service::editor_service`]:
//! the app state holds an `Arc<LspService>` rather than reaching into the
//! manager's internals directly, and the commands layer delegates here.
//!
//! The manager itself is behind a `Mutex` because `start`/`shutdown` are
//! `async` and mutate ownership, while `status`/`restart` are non-async reads
//! or signal sends. The lock is held only for the duration of each call.

use parking_lot::Mutex;

use crate::lsp::manager::{LspConfig, LspManager, LspStatus};
use crate::error::Result;

/// Owns the tinymist bridge and exposes the surface the IPC layer uses.
pub struct LspService {
    manager: Mutex<Option<LspManager>>,
}

impl LspService {
    /// Start the LSP manager and wrap it. `on_status_change` is forwarded to
    /// the manager and invoked on each connection transition — the IPC layer
    /// uses it to emit a Tauri event so the frontend can subscribe instead of
    /// polling. If tinymist is unavailable, the service starts degraded.
    pub async fn start<F>(config: LspConfig, on_status_change: F) -> Result<Self>
    where
        F: Fn(LspStatus) + Send + Sync + 'static,
    {
        let manager = LspManager::start(config, on_status_change)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("LSP start failed: {e}")))?;
        Ok(Self {
            manager: Mutex::new(Some(manager)),
        })
    }

    /// Build a service with no underlying manager — every `status()` reports
    /// unavailable. Used when `start` fails at setup so the app still runs.
    pub fn disabled() -> Self {
        Self {
            manager: Mutex::new(None),
        }
    }

    /// Current LSP connection status. Returns a "fully off" status when no
    /// manager is present (e.g. after shutdown).
    pub fn status(&self) -> LspStatus {
        match self.manager.lock().as_ref() {
            Some(m) => m.status(),
            None => LspStatus {
                running: false,
                ws_url: String::new(),
                available: false,
                reconnecting: false,
            },
        }
    }

    /// Restart the active LSP connection (supersede the live relay + child).
    /// The frontend reconnects automatically and re-runs the `initialize`
    /// handshake against a fresh tinymist. No-op when LSP is disabled.
    pub fn restart(&self) {
        if let Some(m) = self.manager.lock().as_ref() {
            m.restart();
        }
    }
}

#[cfg(test)]
mod tests {
    // The service is a thin wrapper; its behavior is exercised end-to-end via
    // the LspManager (which owns the real network/child logic). Unit tests at
    // this layer would need to stand up a tinymist binary, so they are kept in
    // integration tests rather than here.
    use super::*;

    #[test]
    fn status_when_no_manager_reports_off() {
        let svc = LspService {
            manager: Mutex::new(None),
        };
        let s = svc.status();
        assert!(!s.running);
        assert!(!s.available);
        assert!(s.ws_url.is_empty());
    }

    #[test]
    fn restart_is_a_noop_when_no_manager() {
        let svc = LspService {
            manager: Mutex::new(None),
        };
        // Must not panic.
        svc.restart();
    }
}
