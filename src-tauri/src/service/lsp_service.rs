//! `LspService` — thin orchestration wrapper around [`LspManager`].
//!
//! Mirrors the service-layer pattern of [`crate::service::editor_service`]:
//! the app state holds an `Arc<LspService>` rather than reaching into the
//! manager's internals directly, and the commands layer delegates here.
//!
//! The manager itself is behind a `Mutex` because `start`/`shutdown` are
//! `async` and mutate ownership, while `status`/`restart` are non-async reads
//! or signal sends. The lock is held only for the duration of each call.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::lsp::manager::{LspConfig, LspManager, LspRestartReason, LspStatus, LspStatusKind};
use crate::error::Result;

/// How far above the old manager's generation a relaunch starts the
/// replacement. The frontend's status gate is forward-only, so the new
/// manager must begin strictly higher than anything the old one could still
/// emit. A plain +1 is not enough: a detached old relay that ends
/// *unsolicited* (crash) in the race window after the relaunch read the old
/// generation bumps its own Arc once more and publishes a stale event that
/// could tie or beat the replacement. One relay can bump at most once, so a
/// large jump makes every possible stale event strictly older. Generation
/// values are opaque monotonic markers (never rendered), so jumps are free.
const RELAUNCH_GENERATION_JUMP: u64 = 100;

/// Owns the tinymist bridge and exposes the surface the IPC layer uses.
pub struct LspService {
    manager: Mutex<Option<LspManager>>,
    /// Kept from [`start`](Self::start) so a relaunch can build the
    /// replacement manager with the same status callback (the frontend's
    /// subscription keeps working across the swap).
    on_status_change: Arc<dyn Fn(LspStatus) + Send + Sync>,
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
        let on_status_change = Arc::new(on_status_change);
        let manager = LspManager::start_with_generation(config, 1, on_status_change.clone())
            .await
            .map_err(|e| crate::error::AppError::Other(format!("LSP start failed: {e}")))?;
        Ok(Self {
            manager: Mutex::new(Some(manager)),
            on_status_change,
        })
    }

    /// Build a service with no underlying manager — every `status()` reports
    /// unavailable. Used when `start` fails at setup so the app still runs.
    pub fn disabled() -> Self {
        Self {
            manager: Mutex::new(None),
            on_status_change: Arc::new(|_| {}),
        }
    }

    /// Replace the underlying manager with a fresh one built from `config`.
    ///
    /// Unlike [`restart`](Self::restart) — which keeps the manager (and its
    /// baked-in config) and only forces a reconnect — a relaunch is needed
    /// when the config itself changed or availability must be re-resolved:
    /// a tinymist download just completed, or `lsp.tinymistPath` was edited.
    ///
    /// The old manager is superseded silently (no status event from it — see
    /// `LspManager::supersede_connection`), its listener is stopped, and the
    /// replacement starts [`RELAUNCH_GENERATION_JUMP`] generations higher and
    /// announces itself through the same callback. The frontend therefore
    /// observes one forward generation transition carrying the fresh
    /// `wsUrl` and reconnects.
    ///
    /// Failure leaves the service without a manager (status reports
    /// `Disabled`) — same degraded state as a failed `start` at setup.
    pub async fn relaunch(&self, config: LspConfig) -> Result<()> {
        // Phase 1 — synchronous teardown under the lock. No `.await` may be
        // held across the guard (parking_lot guards are `!Send`, which would
        // make this future non-spawnable), and none is needed: both teardown
        // calls only fire watch channels.
        let start_gen = {
            let mut guard = self.manager.lock();
            match guard.as_mut() {
                Some(old) => {
                    let start_gen =
                        old.current_generation().saturating_add(RELAUNCH_GENERATION_JUMP);
                    // Supersede BEFORE stopping the listener so the live
                    // relay takes its quiet ended-by-restart path (kills the
                    // tinymist child, emits nothing).
                    old.supersede_connection();
                    old.shutdown();
                    guard.take();
                    start_gen
                }
                None => 1,
            }
        };
        // Phase 2 — async start outside the lock. The replacement announces
        // its initial status (unavailable/awaitingClient) itself.
        let manager = LspManager::start_with_generation(
            config,
            start_gen,
            self.on_status_change.clone(),
        )
        .await
        .map_err(|e| crate::error::AppError::Other(format!("LSP relaunch failed: {e}")))?;
        *self.manager.lock() = Some(manager);
        Ok(())
    }

    /// Current LSP connection status (§6.4 generation-aware payload). Returns a
    /// `Disabled` status when no manager is present (e.g. after shutdown) so
    /// the frontend renders "LSP off" rather than an ambiguous offline state.
    pub fn status(&self) -> LspStatus {
        match self.manager.lock().as_ref() {
            Some(m) => m.status(),
            None => LspStatus {
                available: false,
                enabled: false,
                status: LspStatusKind::Disabled,
                generation: 0,
                ws_url: String::new(),
                restart_reason: None,
                message: None,
            },
        }
    }

    /// Restart the active LSP connection with the `Manual` reason — the IPC
    /// path (`restart_lsp`, the "Restart Language Server" button). Supersedes
    /// the live relay + child; the frontend reconnects automatically and
    /// re-runs the `initialize` handshake against a fresh tinymist. No-op when
    /// LSP is disabled.
    pub fn restart(&self) {
        self.request_restart(LspRestartReason::Manual);
    }

    /// Restart the active LSP connection with an explicit reason (§6.3). Used
    /// by Task 8's workspace-change handler (`WorkspaceChange`), the
    /// settings-change handler (`SettingsChange`), and any other programmatic
    /// caller that needs the wire `restartReason` to reflect the trigger. The
    /// manual IPC button routes through [`restart`] (which passes `Manual`).
    pub fn request_restart(&self, reason: LspRestartReason) {
        if let Some(m) = self.manager.lock().as_ref() {
            m.restart(reason);
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
    fn status_when_no_manager_reports_disabled() {
        let svc = LspService::disabled();
        let s = svc.status();
        assert!(!s.available);
        assert!(!s.enabled);
        assert_eq!(s.status, LspStatusKind::Disabled);
        assert!(s.ws_url.is_empty());
        assert_eq!(s.generation, 0);
        assert!(s.restart_reason.is_none());
        assert!(s.message.is_none());
    }

    #[test]
    fn restart_is_a_noop_when_no_manager() {
        let svc = LspService::disabled();
        // Must not panic.
        svc.restart();
        svc.request_restart(LspRestartReason::WorkspaceChange);
    }

    /// `relaunch` swaps the manager and continues ABOVE the old generation
    /// (the frontend's status gate is forward-only). Run with a binary name
    /// that is guaranteed off PATH so the manager runs degraded — no listener,
    /// no child, fully headless.
    #[tokio::test]
    async fn relaunch_replaces_manager_and_advances_generation() {
        let unavailable = LspConfig {
            tinymist_path: "tinymist-definitely-not-on-path-xyz".into(),
            enabled: true,
        };
        let statuses = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = statuses.clone();
        let svc = LspService::start(unavailable.clone(), move |s| {
            sink.lock().push(s);
        })
        .await
        .unwrap();

        let gen1 = svc.status().generation;
        assert_eq!(gen1, 1, "fresh manager starts at generation 1");
        assert!(!svc.status().available);

        svc.relaunch(unavailable.clone()).await.unwrap();

        let after = svc.status();
        assert!(
            after.generation >= gen1 + RELAUNCH_GENERATION_JUMP,
            "relaunched manager starts a generation jump above the old one \
             ({} vs {})",
            after.generation,
            gen1
        );
        assert!(!after.available, "still degraded with the same bad path");

        // The replacement announced through the ORIGINAL callback (the
        // frontend's subscription survives the swap) — at least the initial
        // announcement of the second manager is in the capture, and it
        // carries the jumped generation.
        let has_jump_announce = statuses
            .lock()
            .iter()
            .any(|s| s.generation == after.generation);
        assert!(
            has_jump_announce,
            "the replacement manager announced its generation via the \
             original status callback"
        );
    }

    /// After a relaunch, a config that RESOLVES (the point of relaunching)
    /// produces an available manager. Uses this test binary's own path as a
    /// stand-in executable so `which` succeeds — degraded-vs-available is the
    /// behavior under test, not tinymist itself.
    #[tokio::test]
    async fn relaunch_picks_up_a_new_config() {
        let bad = LspConfig {
            tinymist_path: "tinymist-definitely-not-on-path-xyz".into(),
            enabled: true,
        };
        let svc = LspService::start(bad, |_| {}).await.unwrap();
        assert!(!svc.status().available);

        let good = LspConfig {
            tinymist_path: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
            enabled: true,
        };
        svc.relaunch(good).await.unwrap();

        let after = svc.status();
        assert!(after.available, "relaunch re-resolved availability");
        assert!(!after.ws_url.is_empty(), "available manager publishes an endpoint");
        // Clean up the background listener explicitly; the accept loop parks
        // on the shutdown watch until then.
        let mut guard = svc.manager.lock();
        if let Some(m) = guard.as_mut() {
            m.shutdown();
        }
        drop(guard);
    }
}
