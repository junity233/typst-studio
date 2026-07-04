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
use std::time::Duration;

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

/// Backoff schedule for restarting the accept loop after a fatal listener
/// error (§6.3 "崩溃后指数退避重启"). Each entry is the delay before the next
/// retry attempt. After exhausting this list, the supervisor stops auto-retry
/// and surfaces "LSP unavailable, manual restart required".
///
/// The delays double up to a 30s cap. The whole schedule is ~1m total, which
/// is long enough for transient fd exhaustion / port pressure to clear but
/// short enough that a manual `restart()` (which re-arms the supervisor) can
/// recover immediately if the user intervenes.
const LSP_RESTART_BACKOFF: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
    Duration::from_secs(30),
];

/// Supervision state for the accept loop's restart-with-backoff policy
/// (§6.3). Lives behind an `Arc<Mutex<…>>` shared between the accept loop
/// (which records failures) and `restart()` (which re-arms after exhaustion).
///
/// **Scope**: this supervises ONLY the outer accept loop's fatal-error
/// restart. It does NOT touch the per-connection generation counter,
/// `conn_shutdown`, or the relay — those stay exactly as they were (the
/// Phase-2D "2D" revert lesson: don't touch LSP document ownership / relay
/// routing). This is purely a "the listener died, try again" wrapper.
#[derive(Debug, Default)]
struct LspSupervisor {
    /// How many consecutive fatal accept errors have occurred. Reset to 0 on a
    /// successful accept (a client got through).
    consecutive_failures: u32,
    /// Once we've exhausted [`LSP_RESTART_BACKOFF`], auto-retry stops and this
    /// flips true. `restart()` clears it to re-arm. While true, the accept loop
    /// exits (no more retries) — the frontend shows "manual restart required".
    exhausted: bool,
}

impl LspSupervisor {
    /// Record a fatal accept error. Returns the delay to wait before the next
    /// retry, or `None` if the schedule is exhausted (caller stops retrying).
    fn record_failure(&mut self) -> Option<Duration> {
        let idx = self.consecutive_failures as usize;
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if idx < LSP_RESTART_BACKOFF.len() {
            Some(LSP_RESTART_BACKOFF[idx])
        } else {
            self.exhausted = true;
            None
        }
    }

    /// Record a successful accept (a client connected). Resets the failure
    /// counter so the next fatal error starts backoff from the shortest delay.
    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.exhausted = false;
    }

    /// Re-arm after exhaustion (called by `restart()`). The next fatal error
    /// will begin the backoff schedule from the top.
    fn re_arm(&mut self) {
        self.consecutive_failures = 0;
        self.exhausted = false;
    }

    fn is_exhausted(&self) -> bool {
        self.exhausted
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
    /// Whether the accept-loop is in backoff after a fatal listener error
    /// (§6.3 "状态栏显示不可用、重启中和已降级"). True while waiting to retry;
    /// the frontend shows a "Reconnecting…" spinner. Distinct from `running`
    /// (an active client connection) and `available` (tinymist found).
    pub reconnecting: bool,
}

/// Manages the tinymist child process and its WebSocket bridge.
pub struct LspManager {
    #[allow(dead_code)]
    config: LspConfig,
    ws_port: u16,
    /// Accept-loop shutdown (kills the whole bridge).
    shutdown_tx: Option<watch::Sender<bool>>,
    /// §6.3: bumped by `restart()` to wake an accept loop that parked itself
    /// after exhausting its backoff schedule (waiting for a manual restart).
    /// The loop races this against `shutdown_rx`; a bump re-arms the supervisor
    /// and resumes accepting.
    wake_tx: Option<watch::Sender<u64>>,
    /// Per-connection shutdown (supersedes the live relay + its tinymist).
    /// Used by `restart()` to force a reconnect with a fresh child process.
    conn_shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    running: Arc<AtomicBool>,
    /// §6.3: set true while the accept loop is in backoff after a fatal
    /// listener error (waiting to retry). Surfaced in `LspStatus::reconnecting`
    /// so the frontend can show a "Reconnecting…" spinner.
    reconnecting: Arc<AtomicBool>,
    available: bool,
    /// §6.3 supervision state for the accept loop's restart-with-backoff
    /// policy. Shared with the accept loop task (records failures) and with
    /// `restart()` (re-arms after exhaustion).
    supervisor: Arc<Mutex<LspSupervisor>>,
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
                wake_tx: None,
                conn_shutdown: Arc::new(Mutex::new(None)),
                running: Arc::new(AtomicBool::new(false)),
                reconnecting: Arc::new(AtomicBool::new(false)),
                available,
                supervisor: Arc::new(Mutex::new(LspSupervisor::default())),
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
        let (wake_tx, wake_rx) = watch::channel(0u64);
        let running = Arc::new(AtomicBool::new(false));
        let reconnecting = Arc::new(AtomicBool::new(false));
        let conn_shutdown = Arc::new(Mutex::new(None::<oneshot::Sender<()>>));
        let supervisor = Arc::new(Mutex::new(LspSupervisor::default()));
        let on_status_change = Arc::new(on_status_change);

        let running_clone = running.clone();
        let reconnecting_clone = reconnecting.clone();
        let config_clone = config.clone();
        let conn_shutdown_clone = conn_shutdown.clone();
        let supervisor_clone = supervisor.clone();
        let on_status_clone = on_status_change.clone();

        tokio::spawn(async move {
            if let Err(e) = Self::accept_loop(
                listener,
                shutdown_rx,
                wake_rx,
                running_clone,
                reconnecting_clone,
                conn_shutdown_clone,
                supervisor_clone,
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
            wake_tx: Some(wake_tx),
            conn_shutdown,
            running,
            reconnecting,
            available,
            supervisor,
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
            reconnecting: self.reconnecting.load(Ordering::Relaxed),
        }
    }

    /// Restart the active LSP connection: signal the live relay to wind down,
    /// which kills its tinymist child. The next WebSocket connection (the
    /// frontend reconnects automatically) spawns a fresh tinymist and re-runs
    /// the `initialize` handshake.
    ///
    /// Also re-arms the accept-loop supervisor (§6.3): if auto-retry had
    /// exhausted its backoff schedule (the loop exited and LSP was flagged
    /// unavailable), a manual restart clears that state so the next fatal
    /// error begins backoff from the top. In the common case (no exhaustion)
    /// this is a no-op on the supervisor.
    ///
    /// No-op if no connection is currently active (and not exhausted).
    pub fn restart(&self) {
        // §6.3: re-arm the supervisor so a manual restart recovers from
        // exhaustion. Clear the reconnecting flag (we're acting, not waiting).
        let was_exhausted = self.supervisor.lock().is_exhausted();
        if was_exhausted {
            self.supervisor.lock().re_arm();
            self.reconnecting.store(false, Ordering::Relaxed);
            tracing::info!("LSP manual restart re-armed the supervisor after exhaustion");
            // Re-announce: the frontend should clear its "manual restart
            // required" state. Bump the wake channel to revive a parked loop.
            if let Some(tx) = &self.wake_tx {
                tx.send_modify(|v| *v = v.wrapping_add(1));
            }
            (self.on_status_change)(self.status());
        }
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
        } else if !was_exhausted {
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
    #[allow(clippy::too_many_arguments)]
    async fn accept_loop(
        listener: TcpListener,
        mut shutdown_rx: watch::Receiver<bool>,
        mut wake_rx: watch::Receiver<u64>,
        running: Arc<AtomicBool>,
        reconnecting: Arc<AtomicBool>,
        conn_shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        supervisor: Arc<Mutex<LspSupervisor>>,
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
                        // §6.3: a fatal accept error (fd exhaustion, broken
                        // listener) used to `break` permanently, killing the
                        // bridge. Now we retry with exponential backoff (see
                        // [`LSP_RESTART_BACKOFF`]), surfacing a `reconnecting`
                        // status so the frontend shows a spinner. After the
                        // schedule exhausts, we stop auto-retry and surface
                        // "LSP unavailable, manual restart required" — a
                        // `restart()` re-arms the supervisor.
                        //
                        // We retry on the SAME listener (the port is preserved
                        // so the frontend's WS URL stays valid). fd exhaustion —
                        // the dominant transient cause — clears while we wait,
                        // and the same socket accepts again. A truly broken
                        // listener will keep failing until exhaustion, at which
                        // point the manual-restart path takes over.
                        Err(e) => {
                            tracing::error!("LSP listener accept failed: {e}");
                            running.store(false, Ordering::Relaxed);
                            let delay = supervisor.lock().record_failure();
                            match delay {
                                Some(delay) => {
                                    reconnecting.store(true, Ordering::Relaxed);
                                    on_status_change(LspStatus {
                                        running: false,
                                        ws_url: format!("ws://127.0.0.1:{ws_port}"),
                                        available: true,
                                        reconnecting: true,
                                    });
                                    tracing::warn!(
                                        "LSP accept loop backing off for {delay:?} \
                                         before retrying the listener"
                                    );
                                    // Race the backoff against shutdown so app
                                    // exit during backoff doesn't hang the close.
                                    tokio::select! {
                                        biased;
                                        _ = shutdown_rx.changed() => {
                                            if *shutdown_rx.borrow() {
                                                reconnecting.store(false, Ordering::Relaxed);
                                                break;
                                            }
                                        }
                                        _ = tokio::time::sleep(delay) => {}
                                    }
                                    // Loop back to listener.accept() for the retry.
                                    continue;
                                }
                                None => {
                                    // Schedule exhausted: stop auto-retry. Park
                                    // the loop waiting for either a manual
                                    // `restart()` (which bumps `wake_rx` and
                                    // re-arms the supervisor) or app shutdown.
                                    // The frontend shows "manual restart
                                    // required" (reconnecting=false). We do NOT
                                    // exit — staying parked keeps the listener
                                    // alive so a wake immediately resumes.
                                    tracing::error!(
                                        "LSP accept loop exhausted retries; \
                                         parking until manual restart or shutdown"
                                    );
                                    reconnecting.store(false, Ordering::Relaxed);
                                    on_status_change(LspStatus {
                                        running: false,
                                        ws_url: String::new(),
                                        available: true,
                                        reconnecting: false,
                                    });
                                    // Park. A wake re-arms + resumes; a shutdown
                                    // exits. Either way the loop continues from
                                    // the top after this select.
                                    tokio::select! {
                                        biased;
                                        _ = shutdown_rx.changed() => {
                                            if *shutdown_rx.borrow() {
                                                tracing::info!(
                                                    "LSP manager shutting down \
                                                     (was parked on exhaustion)"
                                                );
                                                break;
                                            }
                                            continue;
                                        }
                                        _ = wake_rx.changed() => {
                                            tracing::info!(
                                                "LSP accept loop woken by \
                                                 manual restart; resuming"
                                            );
                                            continue;
                                        }
                                    }
                                }
                            }
                        }
                    };

                    // A client got through — reset the supervisor's failure
                    // counter so the next fatal error starts backoff fresh.
                    supervisor.lock().record_success();
                    reconnecting.store(false, Ordering::Relaxed);

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
                        reconnecting: false,
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
                                reconnecting: false,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_returns_increasing_backoff_delays() {
        let mut sup = LspSupervisor::default();
        // First failure → shortest delay.
        let d0 = sup.record_failure().expect("first retry has a delay");
        assert_eq!(d0, Duration::from_secs(1));
        let d1 = sup.record_failure().expect("second retry has a delay");
        assert_eq!(d1, Duration::from_secs(2));
        let d2 = sup.record_failure().expect("third retry has a delay");
        assert_eq!(d2, Duration::from_secs(4));
        assert!(!sup.is_exhausted(), "not exhausted yet");
    }

    #[test]
    fn supervisor_exhausts_after_schedule() {
        let mut sup = LspSupervisor::default();
        // Drain the whole schedule.
        for _ in 0..LSP_RESTART_BACKOFF.len() {
            assert!(sup.record_failure().is_some(), "schedule still has delays");
        }
        // One past the end → None + exhausted.
        assert!(
            sup.record_failure().is_none(),
            "past the schedule → no delay"
        );
        assert!(sup.is_exhausted(), "exhausted after draining schedule");
    }

    #[test]
    fn supervisor_record_success_resets_failures() {
        let mut sup = LspSupervisor::default();
        sup.record_failure();
        sup.record_failure();
        // A successful accept resets the counter.
        sup.record_success();
        assert_eq!(sup.consecutive_failures, 0);
        assert!(!sup.is_exhausted());
        // Next failure starts from the shortest delay again.
        let d = sup.record_failure().expect("delay after reset");
        assert_eq!(d, Duration::from_secs(1));
    }

    #[test]
    fn supervisor_re_arm_clears_exhaustion() {
        let mut sup = LspSupervisor::default();
        for _ in 0..=LSP_RESTART_BACKOFF.len() {
            let _ = sup.record_failure();
        }
        assert!(sup.is_exhausted());
        sup.re_arm();
        assert!(!sup.is_exhausted());
        assert_eq!(sup.consecutive_failures, 0);
        // Re-armed: the next failure yields the shortest delay.
        let d = sup.record_failure().expect("re-armed yields a delay");
        assert_eq!(d, Duration::from_secs(1));
    }

    #[test]
    fn lsp_status_carries_reconnecting_field() {
        // The wire type must round-trip the new field.
        let s = LspStatus {
            running: false,
            ws_url: "ws://127.0.0.1:1".into(),
            available: true,
            reconnecting: true,
        };
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"reconnecting\":true"), "json: {json}");
        assert!(json.contains("\"wsUrl\""), "camelCase wire field: {json}");
    }
}
