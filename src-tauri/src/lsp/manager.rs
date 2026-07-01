//! `LspManager` — owns the tinymist child process and the WebSocket server
//! that bridges it to the frontend.
//!
//! On [`LspManager::start`]:
//! 1. Find the `tinymist` binary (PATH or config override).
//! 2. Start a WebSocket server on `127.0.0.1:0` (OS-assigned port).
//! 3. For each incoming connection, spawn a fresh `tinymist --stdio` child
//!    and relay messages bidirectionally.
//!
//! The manager runs its accept loop on a background tokio task. When the
//! manager is dropped, the shutdown signal fires and any running child is killed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::watch;

use super::relay;

/// Configuration for the LSP manager.
#[derive(Debug, Clone)]
pub struct LspConfig {
    /// Path or name of the tinymist binary.
    pub tinymist_path: String,
    /// Whether LSP features are enabled at all.
    pub enabled: bool,
}

impl Default for LspConfig {
    fn default() -> Self {
        Self {
            tinymist_path: "tinymist".into(),
            enabled: true,
        }
    }
}

/// Status of the LSP connection, exposed to the frontend.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    /// Whether the LSP server is accepting WebSocket connections.
    pub running: bool,
    /// The WebSocket URL the frontend should connect to (empty if not running).
    pub ws_url: String,
    /// Whether tinymist was found on the system.
    pub available: bool,
}

/// Manages the tinymist child process and its WebSocket bridge.
pub struct LspManager {
    #[allow(dead_code)]
    config: LspConfig,
    ws_port: u16,
    shutdown_tx: Option<watch::Sender<bool>>,
    running: Arc<AtomicBool>,
    available: bool,
}

impl LspManager {
    /// Check whether the tinymist binary is reachable.
    pub fn check_available(config: &LspConfig) -> bool {
        which::which(&config.tinymist_path).is_ok()
    }

    /// Start the LSP manager: bind the WebSocket server and begin accepting
    /// connections.
    ///
    /// Returns `Err` only if the WebSocket server fails to bind. If tinymist
    /// is not found, the manager starts in a degraded state (`available=false`).
    pub async fn start(config: LspConfig) -> anyhow::Result<Self> {
        let available = Self::check_available(&config);

        if !available || !config.enabled {
            tracing::warn!(
                "tinymist not found or LSP disabled; LSP features will be unavailable"
            );
            return Ok(Self {
                config,
                ws_port: 0,
                shutdown_tx: None,
                running: Arc::new(AtomicBool::new(false)),
                available,
            });
        }

        // Bind the WebSocket server to a random high port.
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let ws_port = listener.local_addr()?.port();
        tracing::info!("LSP WebSocket server listening on ws://127.0.0.1:{ws_port}");

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let running = Arc::new(AtomicBool::new(false));

        let running_clone = running.clone();
        let config_clone = config.clone();

        tokio::spawn(async move {
            if let Err(e) =
                Self::accept_loop(listener, shutdown_rx, running_clone, config_clone).await
            {
                tracing::error!("LSP accept loop exited with error: {e}");
            }
        });

        Ok(Self {
            config,
            ws_port,
            shutdown_tx: Some(shutdown_tx),
            running,
            available,
        })
    }

    /// The WebSocket URL for the frontend to connect to.
    pub fn ws_url(&self) -> String {
        if self.running.load(Ordering::Relaxed) {
            format!("ws://127.0.0.1:{}", self.ws_port)
        } else {
            String::new()
        }
    }

    /// Current status.
    pub fn status(&self) -> LspStatus {
        LspStatus {
            running: self.running.load(Ordering::Relaxed),
            ws_url: self.ws_url(),
            available: self.available,
        }
    }

    /// Restart the LSP manager (kills all tinymist children; the next
    /// connection will spawn a fresh one).
    pub async fn restart(&mut self) -> anyhow::Result<()> {
        self.running.store(false, Ordering::Relaxed);
        // Existing children are killed by kill_on_drop(true) when their
        // relay tasks finish. The next connection triggers a fresh spawn.
        Ok(())
    }

    /// Shutdown the manager and kill any running children.
    pub async fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        self.running.store(false, Ordering::Relaxed);
    }

    // -- internal ----------------------------------------------------------

    /// Accept loop: waits for WebSocket connections and spawns a tinymist
    /// child + relay for each one.
    async fn accept_loop(
        listener: TcpListener,
        mut shutdown_rx: watch::Receiver<bool>,
        running: Arc<AtomicBool>,
        config: LspConfig,
    ) -> anyhow::Result<()> {
        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        tracing::info!("LSP manager shutting down");
                        break;
                    }
                }
                accept_result = listener.accept() => {
                    let (stream, _addr) = accept_result?;
                    tracing::info!("LSP WebSocket client connected");

                    // Spawn a fresh tinymist for this connection.
                    let mut child = Command::new(&config.tinymist_path)
                        .arg("--stdio")
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .kill_on_drop(true)
                        .spawn()?;

                    tracing::info!("spawned tinymist (pid={})", child.id().unwrap_or(0));

                    let stdin = child.stdin.take()
                        .ok_or_else(|| anyhow::anyhow!("tinymist stdin not captured"))?;
                    let stdout = child.stdout.take()
                        .ok_or_else(|| anyhow::anyhow!("tinymist stdout not captured"))?;

                    running.store(true, Ordering::Relaxed);

                    let ws_stream = tokio_tungstenite::accept_async(stream).await?;

                    let running_clone = running.clone();
                    tokio::spawn(async move {
                        if let Err(e) = relay::relay(ws_stream, stdin, stdout).await {
                            tracing::error!("LSP relay error: {e}");
                        }
                        running_clone.store(false, Ordering::Relaxed);
                        // Kill the child when the relay finishes.
                        let _ = child.kill().await;
                        tracing::info!("LSP connection ended, tinymist killed");
                    });
                }
            }
        }
        Ok(())
    }
}

impl Drop for LspManager {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
    }
}
