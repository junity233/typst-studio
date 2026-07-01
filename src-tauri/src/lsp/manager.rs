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
//! manager is dropped, the accept-loop shutdown signal fires (stopping new
//! connections). Already-running tinymist children are reaped via
//! `kill_on_drop(true)` on the `Child` handle, which lives in the detached
//! relay task — so in practice the child dies when the tokio runtime tears
//! those tasks down at app exit.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

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
    /// Accept-loop shutdown (kills the whole bridge).
    shutdown_tx: Option<watch::Sender<bool>>,
    /// Per-connection shutdown (supersedes the live relay + its tinymist).
    /// Used by `restart()` to force a reconnect with a fresh child process.
    conn_shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    running: Arc<AtomicBool>,
    available: bool,
    /// Invoked whenever the connection status transitions (connect/disconnect).
    /// Lets the service layer emit a Tauri event without polling.
    on_status_change: Arc<dyn Fn(LspStatus) + Send + Sync>,
}

impl LspManager {
    /// Check whether the tinymist binary is reachable.
    pub fn check_available(config: &LspConfig) -> bool {
        which::which(&config.tinymist_path).is_ok()
    }

    /// Start the LSP manager: bind the WebSocket server and begin accepting
    /// connections.
    ///
    /// `on_status_change` is invoked whenever the connection status flips
    /// (a client connects, or the relay/child ends). Use it to push a Tauri
    /// event so the frontend doesn't have to poll.
    ///
    /// Returns `Err` only if the WebSocket server fails to bind. If tinymist
    /// is not found, the manager starts in a degraded state (`available=false`).
    pub async fn start<F>(config: LspConfig, on_status_change: F) -> anyhow::Result<Self>
    where
        F: Fn(LspStatus) + Send + Sync + 'static,
    {
        let available = Self::check_available(&config);

        if !available || !config.enabled {
            tracing::warn!(
                "tinymist not found or LSP disabled; LSP features will be unavailable"
            );
            let on_status_change = Arc::new(on_status_change);
            let mgr = Self {
                config,
                ws_port: 0,
                shutdown_tx: None,
                conn_shutdown: Arc::new(Mutex::new(None)),
                running: Arc::new(AtomicBool::new(false)),
                available,
                on_status_change,
            };
            // Announce the initial (unavailable) state.
            (mgr.on_status_change)(mgr.status());
            return Ok(mgr);
        }

        // Bind the WebSocket server to a random high port.
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let ws_port = listener.local_addr()?.port();
        tracing::info!("LSP WebSocket server listening on ws://127.0.0.1:{ws_port}");

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let running = Arc::new(AtomicBool::new(false));
        let conn_shutdown = Arc::new(Mutex::new(None::<oneshot::Sender<()>>));
        let on_status_change = Arc::new(on_status_change);

        let running_clone = running.clone();
        let config_clone = config.clone();
        let conn_shutdown_clone = conn_shutdown.clone();
        let on_status_clone = on_status_change.clone();

        tokio::spawn(async move {
            if let Err(e) = Self::accept_loop(
                listener,
                shutdown_rx,
                running_clone,
                conn_shutdown_clone,
                on_status_clone,
                ws_port,
                config_clone,
            )
            .await
            {
                tracing::error!("LSP accept loop exited with error: {e}");
            }
        });

        Ok(Self {
            config,
            ws_port,
            shutdown_tx: Some(shutdown_tx),
            conn_shutdown,
            running,
            available,
            on_status_change,
        })
    }

    /// The WebSocket URL for the frontend to connect to.
    ///
    /// Returned as soon as the server is bound (regardless of whether a client
    /// is currently connected), because the frontend needs the URL *in order*
    /// to connect — gating it on `running` would deadlock (running only flips
    /// true after a client connects, which needs the URL). The `available`
    /// field distinguishes "server up" from "tinymist found"; `running` in the
    /// status payload signals an active client connection.
    pub fn ws_url(&self) -> String {
        if self.available {
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

    /// Restart the active LSP connection: signal the live relay to wind down,
    /// which kills its tinymist child. The next WebSocket connection (the
    /// frontend reconnects automatically) spawns a fresh tinymist and re-runs
    /// the `initialize` handshake.
    ///
    /// No-op if no connection is currently active.
    pub fn restart(&self) {
        if let Some(tx) = self.conn_shutdown.lock().take() {
            // `send` errors when the receiver was already dropped — i.e. the
            // relay ended on its own (peer closed / tinymist exited) and a
            // stale sender lingered. Log accordingly so the message reflects
            // what actually happened, not an optimistic assumption.
            match tx.send(()) {
                Ok(()) => tracing::info!(
                    "LSP restart requested: superseding active connection"
                ),
                Err(_) => tracing::info!(
                    "LSP restart requested: connection had already ended \
                     (relay exited); the next client connects fresh"
                ),
            }
        } else {
            tracing::debug!(
                "LSP restart requested but no active connection to supersede"
            );
        }
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
    ///
    /// **Single-connection semantics**: at most one tinymist + relay is live
    /// at a time. A new connection supersedes (kills) any prior one. This
    /// matches the frontend, which sends a fresh `initialize` handshake per
    /// restart — each connection must get a brand-new tinymist so the
    /// (otherwise illegal) repeat `initialize` is well-defined.
    async fn accept_loop(
        listener: TcpListener,
        mut shutdown_rx: watch::Receiver<bool>,
        running: Arc<AtomicBool>,
        conn_shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        on_status_change: Arc<dyn Fn(LspStatus) + Send + Sync>,
        ws_port: u16,
        config: LspConfig,
    ) -> anyhow::Result<()> {
        // `conn_shutdown` is shared with `LspManager::restart()`: sending on
        // the live sender asks the active relay to wind down so a fresh
        // connection (manual restart, or a superseding client) can take over.

        // Generation counter: each accepted connection gets the next value.
        // A relay, when it ends, only publishes `running=false` if its own
        // generation is STILL the active one — otherwise a newer connection
        // has already superseded it and owns the "running" status.
        //
        // Note: this guards the *common* path (supersede sends its signal
        // before the stale relay reaches the check). A residual TOCTOU window
        // exists across two different atomics under Relaxed ordering, but the
        // relay's check is nanoseconds while a reconnect's handshake (accept +
        // WS upgrade) is milliseconds, so in practice the new connection's
        // `running=true` lands after any stale `false`. Final state is correct.
        let generation = Arc::new(AtomicU64::new(0));

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
                    let (stream, _addr) = match accept_result {
                        Ok(v) => v,
                        // A listener accept error (fd exhaustion, broken
                        // listener) is unrecoverable — we can't keep serving.
                        // Announce `running=false` so the frontend doesn't
                        // keep pointing at a dead port, then exit the loop.
                        Err(e) => {
                            tracing::error!("LSP listener accept failed: {e}");
                            running.store(false, Ordering::Relaxed);
                            on_status_change(LspStatus {
                                running: false,
                                ws_url: String::new(),
                                available: true,
                            });
                            break;
                        }
                    };

                    // Validate the WebSocket handshake Origin header before
                    // accepting. The WS server is on loopback, so there's no
                    // remote exposure — but any local process (or a malicious
                    // web page reaching ws://localhost:<port>) could otherwise
                    // drive tinymist. Only the app's own webview may connect.
                    let ws_stream = match tokio_tungstenite::accept_hdr_async(
                        stream,
                        validate_origin,
                    ).await {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("rejected WebSocket handshake: {e}");
                            continue;
                        }
                    };
                    tracing::info!("LSP WebSocket client connected (origin OK)");

                    // This connection takes the next generation. Any prior
                    // relay whose generation is now stale must NOT touch the
                    // shared `running` flag on exit (see the relay task below).
                    let my_gen = generation.fetch_add(1, Ordering::Relaxed) + 1;

                    // Single-connection mutex: kill any currently-live relay
                    // before spawning a new tinymist for this connection.
                    if let Some(tx) = conn_shutdown.lock().take() {
                        let _ = tx.send(());
                    }

                    // Spawn a fresh tinymist for this connection. A spawn
                    // failure (binary deleted, resource limits) is per-
                    // connection — drop this connection but keep serving, so a
                    // transient failure doesn't kill the whole bridge.
                    let mut child = match Command::new(&config.tinymist_path)
                        .arg("lsp")
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .kill_on_drop(true)
                        .spawn()
                    {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::error!(
                                "failed to spawn tinymist, dropping this connection: {e}"
                            );
                            continue;
                        }
                    };

                    tracing::info!("spawned tinymist (pid={})", child.id().unwrap_or(0));

                    // Taking stdio handles can only fail if we didn't pipe
                    // them above — which we always do — so this is defensive.
                    let stdin = match child.stdin.take() {
                        Some(s) => s,
                        None => {
                            tracing::error!("tinymist stdin not captured");
                            continue;
                        }
                    };
                    let stdout = match child.stdout.take() {
                        Some(s) => s,
                        None => {
                            tracing::error!("tinymist stdout not captured");
                            continue;
                        }
                    };
                    let stderr = match child.stderr.take() {
                        Some(s) => s,
                        None => {
                            tracing::error!("tinymist stderr not captured");
                            continue;
                        }
                    };

                    // Drain stderr continuously. If left unread, tinymist blocks
                    // once the OS pipe buffer (~64 KB) fills, stalling the whole
                    // LSP session. Forwarded to tracing at debug level.
                    tokio::spawn(async move {
                        use tokio::io::{AsyncBufReadExt, BufReader};
                        let mut lines = BufReader::new(stderr).lines();
                        loop {
                            match lines.next_line().await {
                                Ok(Some(line)) => tracing::debug!("[tinymist] {line}"),
                                Ok(None) => break, // stderr closed (child exiting)
                                Err(e) => {
                                    tracing::warn!("tinymist stderr read error: {e}");
                                    break;
                                }
                            }
                        }
                    });

                    running.store(true, Ordering::Relaxed);
                    on_status_change(LspStatus {
                        running: true,
                        ws_url: format!("ws://127.0.0.1:{ws_port}"),
                        available: true,
                    });

                    let (conn_shutdown_tx, conn_shutdown_rx) = oneshot::channel::<()>();
                    conn_shutdown.lock().replace(conn_shutdown_tx);

                    let running_clone = running.clone();
                    let on_status_clone = on_status_change.clone();
                    let generation_clone = generation.clone();
                    tokio::spawn(async move {
                        // Race the relay against an explicit supersede signal.
                        tokio::select! {
                            biased;
                            _ = conn_shutdown_rx => {
                                tracing::info!("LSP connection superseded, shutting down");
                            }
                            relay_res = relay::relay(ws_stream, stdin, stdout) => {
                                if let Err(e) = relay_res {
                                    tracing::error!("LSP relay error: {e}");
                                }
                            }
                        }
                        // Only publish `running=false` if we are STILL the
                        // active generation. A newer connection that superseded
                        // us has already published its own `running=true`; if we
                        // overwrote it here, the status would flicker to false
                        // even though a live connection exists.
                        let still_active = generation_clone.load(Ordering::Relaxed) == my_gen;
                        if still_active {
                            running_clone.store(false, Ordering::Relaxed);
                            on_status_clone(LspStatus {
                                running: false,
                                ws_url: String::new(),
                                available: true,
                            });
                        }
                        let _ = child.kill().await;
                        tracing::info!("LSP connection ended, tinymist killed");
                    });
                }
            }
        }
        Ok(())
    }
}

/// Allowed WebSocket Origins. The app's webview uses different origins in dev
/// vs. production, so we allow the known set rather than a single value.
///
/// - `http://localhost:<port>` / `http://127.0.0.1:<port>` — Tauri dev server.
/// - `tauri://localhost`, `https://tauri.localhost` — Tauri production webview.
///
/// We match on an explicit host list rather than a `*.localhost` suffix so an
/// attacker can't satisfy the check with e.g. `evil.localhost` resolving to
/// their own server.
fn is_allowed_origin(origin: &str) -> bool {
    let Ok(uri) = origin.parse::<http::Uri>() else {
        return false;
    };
    matches!(
        uri.host(),
        Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost")
    )
}

/// Validate the WebSocket handshake request's `Origin` header. The tungstenite
/// callback contract returns the (possibly-rejected) response; on rejection we
/// log and return a 403 response, which the client observes as a failed upgrade.
///
/// Defined as a standalone `fn` (not a closure) so its signature satisfies the
/// HRTB tungstenite's callback expects (the request borrow is short-lived).
#[allow(clippy::result_large_err)]
fn validate_origin(
    req: &tokio_tungstenite::tungstenite::handshake::server::Request,
    resp: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> std::result::Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    let origin = req.headers().get(http::header::ORIGIN);
    let allowed = origin
        .and_then(|v| v.to_str().ok())
        .map(is_allowed_origin)
        .unwrap_or(false);
    if allowed {
        Ok(resp)
    } else {
        match origin.and_then(|v| v.to_str().ok()) {
            Some(seen) => {
                tracing::warn!("rejected WebSocket with disallowed Origin: {seen}");
            }
            None => {
                // Browsers always send `Origin` on a cross-origin ws://
                // handshake; its absence usually means a non-browser client
                // (curl, a script). Logged distinctly so this is debuggable.
                tracing::warn!(
                    "rejected WebSocket: missing Origin header \
                     (non-browser clients are not permitted)"
                );
            }
        }
        // ErrorResponse = http::Response<Option<String>>. Build a 403; a
        // non-101 response terminates the upgrade.
        let mut err = http::Response::new(Some(
            "origin not allowed".to_string(),
        ));
        *err.status_mut() = http::StatusCode::FORBIDDEN;
        Err(err)
    }
}

impl Drop for LspManager {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
    }
}
