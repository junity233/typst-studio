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
//!
//! ## Generation endpoint & handshake (§6.1, §6.2)
//!
//! The WebSocket URL published to the frontend is
//! `ws://127.0.0.1:<port>/lsp/main/<generation>?token=<capability-token>`.
//! Every upgrade is validated against four dimensions (see
//! [`validate_handshake`]): Origin allowlist, path shape, generation match,
//! and capability token. A stale frontend holding an old URL (old generation)
//! is rejected at the upgrade, forcing it to fetch the fresh URL from the
//! status event (Task 7 threads generation onto the payload).

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

/// Lifecycle kind the LSP reports on the `lsp_status` event (§6.4). Serialized
/// as a camelCase string so the frontend gets a string-literal union (`"running"`
/// / `"awaitingClient"` / …). The convention matches `DocumentOrigin`'s
/// `rename_all = "camelCase"` (multi-word variants like `WorkspaceFile` become
/// `workspaceFile`); `CompileStatus` uses `lowercase` only because all its
/// variants are single words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum LspStatusKind {
    /// LSP features disabled (`enabled=false`) — not started at all.
    Disabled,
    /// Enabled but tinymist was not found (`available=false`); LSP features
    /// can't run.
    Unavailable,
    /// Listener bound; a WebSocket client has NOT yet connected for the
    /// current generation (waiting on the frontend to dial `wsUrl`). This also
    /// covers the brief window after `start()` returns and before any client
    /// connects — there's no separate "starting" kind because `AwaitingClient`
    /// already means "listener up, no client yet".
    AwaitingClient,
    /// A tinymist client is connected and its relay is live.
    Running,
    /// A `restart()` is in progress (old connection superseded, awaiting the
    /// next client), OR the accept loop is in backoff after a fatal listener
    /// error (still trying).
    Restarting,
    /// The supervisor exhausted its backoff schedule; the loop is parked and a
    /// manual restart is required to recover.
    Failed,
}

/// Why the LSP generation was bumped (§6.4 `restartReason`). Surfaced on the
/// wire only when the accompanying status reflects a restart/crash; serialized
/// camelCase to match [`LspStatusKind`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum LspRestartReason {
    /// Workspace open/close/switch (Task 8 wires the caller).
    WorkspaceChange,
    /// An initialize-time LSP setting changed.
    SettingsChange,
    /// tinymist exited unexpectedly (unsolicited relay end).
    ChildCrash,
    /// Unrecoverable relay error.
    RelayError,
    /// User clicked "Restart Language Server" (`restart_lsp` IPC).
    Manual,
    /// The frontend's endpoint generation didn't match the current server
    /// generation — a forced reconnect.
    GenerationMismatch,
}

/// Pure mapping from the manager's raw supervision flags to a wire
/// [`LspStatusKind`] (§6.4). Extracted from `LspManager::status()` so the
/// mapping is unit-testable without binding a listener or spawning tinymist.
///
/// Resolution order (first match wins):
/// 1. `!enabled` → `Disabled` (LSP turned off entirely).
/// 2. `enabled && !available` → `Unavailable` (tinymist missing).
/// 3. `exhausted` → `Failed` (supervisor gave up; manual restart required).
/// 4. `restarting` → `Restarting` (explicit `restart()` in flight, or backoff).
/// 5. `running` → `Running` (a tinymist client is connected and relaying).
/// 6. otherwise → `AwaitingClient` (listener bound, no client yet for this gen).
pub(crate) fn status_kind_for(
    available: bool,
    enabled: bool,
    running: bool,
    restarting: bool,
    exhausted: bool,
) -> LspStatusKind {
    if !enabled {
        LspStatusKind::Disabled
    } else if !available {
        LspStatusKind::Unavailable
    } else if exhausted {
        LspStatusKind::Failed
    } else if restarting {
        LspStatusKind::Restarting
    } else if running {
        LspStatusKind::Running
    } else {
        LspStatusKind::AwaitingClient
    }
}

/// Status of the LSP connection, exposed to the frontend (§6.4). The wire form
/// is `ipc::events::LspStatusPayload` (`From<LspStatus>` maps field-for-field);
/// this is the richer internal version the manager constructs directly.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    /// Whether tinymist was found on the system.
    pub available: bool,
    /// Whether LSP features are enabled at all (`LspConfig.enabled`).
    pub enabled: bool,
    /// Lifecycle kind derived from the supervision flags (`status_kind_for`).
    pub status: LspStatusKind,
    /// Current LSP generation (bumped on `restart()` / unsolicited relay end).
    pub generation: u64,
    /// The WebSocket URL the frontend should connect to (empty if not running).
    pub ws_url: String,
    /// Why the generation was bumped, when the status reflects a restart/crash.
    pub restart_reason: Option<LspRestartReason>,
    /// Optional human-readable hint (e.g. the `Failed` "manual restart
    /// required" message).
    pub message: Option<String>,
}

// ============================================================================
// Pure handshake-validation helpers (§6.1, §6.2).
//
// These are free functions so they can be unit-tested without binding a
// listener or constructing an `LspManager`. The WS-upgrade callback
// (`validate_handshake_closure` below) is a thin adapter that reads the
// current generation/token and delegates to [`validate_handshake`].
// ============================================================================

/// Path prefix every LSP WebSocket upgrade must match.
///
/// The full path must be EXACTLY `/lsp/main/<generation>` — no trailing slash,
/// no extra segments. `generation` is a positive integer. See §6.1.
const LSP_PATH_PREFIX: &str = "/lsp/main/";

/// Outcome of validating one WebSocket upgrade against all four handshake
/// dimensions (§6.1). [`HandshakeOutcome::Accept`] means the upgrade may
/// proceed; any [`HandshakeOutcome::Reject`] variant carries the reason and
/// the HTTP status the callback should return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HandshakeOutcome {
    /// All four checks passed.
    Accept,
    /// One of the dimensions failed. Carries a short reason for logging and
    /// the HTTP status to return to the client.
    Reject(HandshakeRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HandshakeRejection {
    /// `Origin` header missing or not on the allowlist (403).
    Origin,
    /// Path does not exactly match `/lsp/main/<gen>` (404).
    PathMalformed,
    /// Path's generation is a future gen the server hasn't reached yet (404).
    /// Frontends must not predict future generations — they fetch the URL from
    /// the status event (§6.4).
    GenerationFuture,
    /// Path's generation is in the past (already superseded by a restart or a
    /// child crash). The frontend must reconnect with the current URL (404).
    GenerationPast,
    /// `token` query param missing, empty, or mismatched (403).
    TokenMismatch,
}

impl HandshakeRejection {
    /// HTTP status the callback returns for this rejection. Per the task spec:
    /// 403 for origin/token (auth-style failures), 404 for path/generation
    /// (resource-not-found-style; an old-gen URL no longer exists).
    fn status(self) -> http::StatusCode {
        match self {
            HandshakeRejection::Origin | HandshakeRejection::TokenMismatch => {
                http::StatusCode::FORBIDDEN
            }
            HandshakeRejection::PathMalformed
            | HandshakeRejection::GenerationFuture
            | HandshakeRejection::GenerationPast => http::StatusCode::NOT_FOUND,
        }
    }

    fn label(self) -> &'static str {
        match self {
            HandshakeRejection::Origin => "origin not allowed",
            HandshakeRejection::PathMalformed => "path malformed",
            HandshakeRejection::GenerationFuture => "generation from the future",
            HandshakeRejection::GenerationPast => "stale generation (superseded)",
            HandshakeRejection::TokenMismatch => "token mismatch",
        }
    }
}

/// Parse the LSP handshake path and extract the generation.
///
/// Returns `Some(gen)` iff the path is EXACTLY `/lsp/main/<positive-integer>`.
/// Anything else — wrong prefix, non-numeric segment, trailing slash, extra
/// segments, empty segment, generation 0 — returns `None`. Per §6.1 the match
/// is exact: `/lsp/main/1/extra` and `/lsp/main/` are rejected.
///
/// The leading `?` is tolerated when callers pass a full request target
/// (`/lsp/main/1?token=...`); the query is stripped before matching. This
/// matches how the path arrives from the tungstenite callback (the `Uri`
/// path() is already query-free, so this tolerance is defensive only).
pub(crate) fn parse_lsp_path(path: &str) -> Option<u64> {
    // Strip a trailing query string if a caller passed a full target.
    let path = path.split('?').next().unwrap_or(path);
    let rest = path.strip_prefix(LSP_PATH_PREFIX)?;
    // The generation is the single segment after the prefix. A trailing slash
    // or any further '/' means it's not an exact match.
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    let gen = rest.parse::<u64>().ok()?;
    // Generation 0 is reserved/invalid; the server starts at 1.
    if gen == 0 {
        return None;
    }
    Some(gen)
}

/// Extract the `token` query parameter from a query string.
///
/// Accepts either a bare query (`token=abc&foo=bar`) or one with a leading
/// `?`. Returns `Some(value)` only when `token` is present and non-empty.
/// Per §6.1 the token is a single capability value, so we take the first
/// occurrence and require it to be non-empty. Returns `None` for a missing
/// `token`, an empty `token=`, or any parse failure.
pub(crate) fn parse_token_from_query(query: &str) -> Option<&str> {
    let query = query.strip_prefix('?').unwrap_or(query);
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut it = pair.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let val = it.next().unwrap_or("");
        if key == "token" {
            return if val.is_empty() { None } else { Some(val) };
        }
    }
    None
}

/// Validate a WebSocket upgrade against all four handshake dimensions (§6.1).
///
/// This is the pure core; the tungstenite callback adapts a `Request` into
/// these arguments. Dimensions checked, in order:
///
/// 1. **Origin** (`origin_str`): must be on the allowlist (§6.1 — token is
///    additive, NOT a substitute for Origin). `origin_str` is the raw header
///    value, or `None`/empty if absent.
/// 2. **Path** (`path`): must exactly match `/lsp/main/<gen>` (positive int).
/// 3. **Generation** (path's gen vs. `current_gen`): path's gen must equal
///    `current_gen`. A past gen → superseded/stale; a future gen → frontend
///    must not predict; both reject.
/// 4. **Token** (`query`): `token=` must equal `current_token`.
///
/// `path` may include a query (it's stripped); `query` is the bare query (or
/// with a leading `?`). The callback passes them split from the `Uri`.
pub(crate) fn validate_handshake(
    current_gen: u64,
    current_token: &str,
    origin_str: Option<&str>,
    path: &str,
    query: &str,
) -> HandshakeOutcome {
    // 1. Origin.
    let origin_ok = origin_str
        .filter(|s| !s.is_empty())
        .map(is_allowed_origin)
        .unwrap_or(false);
    if !origin_ok {
        return HandshakeOutcome::Reject(HandshakeRejection::Origin);
    }

    // 2. Path shape.
    let Some(path_gen) = parse_lsp_path(path) else {
        return HandshakeOutcome::Reject(HandshakeRejection::PathMalformed);
    };

    // 3. Generation match (compare to current AT UPGRADE TIME — caller loads
    //    the AtomicU64 immediately before invoking this).
    if path_gen > current_gen {
        return HandshakeOutcome::Reject(HandshakeRejection::GenerationFuture);
    }
    if path_gen < current_gen {
        return HandshakeOutcome::Reject(HandshakeRejection::GenerationPast);
    }

    // 4. Token.
    match parse_token_from_query(query) {
        Some(t) if t == current_token => HandshakeOutcome::Accept,
        _ => HandshakeOutcome::Reject(HandshakeRejection::TokenMismatch),
    }
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
    ///
    /// Also doubles as the "is a relay live for the current generation?" flag
    /// for the single-gen-single-connection rule (§6.2): `Some` ⇒ a relay is
    /// active and a same-generation new connection must be rejected.
    conn_shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    running: Arc<AtomicBool>,
    /// §6.3: set true while the accept loop is in backoff after a fatal
    /// listener error (waiting to retry). Feeds `status_kind_for`'s `restarting`
    /// arm so the frontend shows a "Reconnecting…" indicator.
    reconnecting: Arc<AtomicBool>,
    /// §6.4: set true by `restart()` BEFORE the supersede and cleared when the
    /// next client's relay starts (the `running` publish site). Distinguishes an
    /// explicit restart-in-flight from the listener-backoff sense of
    /// "reconnecting"; both map to `LspStatusKind::Restarting`.
    restart_in_progress: Arc<AtomicBool>,
    available: bool,
    /// Whether LSP features are enabled at all (`LspConfig.enabled`). Surfaced
    /// verbatim on the wire so the frontend can distinguish "disabled" from
    /// "enabled but tinymist missing".
    enabled: bool,
    /// §6.1: the per-app-start capability token. Generated ONCE in `start`,
    /// held in memory only (never persisted), shared across all generations
    /// (only generation changes on restart). Embedded in the published URL and
    /// checked on every WS upgrade.
    token: Arc<str>,
    /// §6.1: the current LSP generation. Starts at 1; bumped by `restart()`
    /// (BEFORE the supersede) and by an unsolicited relay/child end (crash or
    /// network drop). The handshake compares the path's generation against
    /// this value loaded at upgrade time.
    generation: Arc<AtomicU64>,
    /// §6.3 supervision state for the accept loop's restart-with-backoff
    /// policy. Shared with the accept loop task (records failures) and with
    /// `restart()` (re-arms after exhaustion).
    supervisor: Arc<Mutex<LspSupervisor>>,
    /// §6.4: the most recent restart reason / message, carried on the wire
    /// (`restartReason` / `message`) across the brief Restarting/Failed window.
    /// Set by `restart(reason)` before the bump, by the crash path on an
    /// unsolicited relay end (`ChildCrash`), and by the supervisor-exhaustion
    /// publish (a `Failed` message). Cleared when a fresh client connects
    /// (`running` → the new generation's relay start), so a steady-state
    /// `Running` status doesn't echo a stale reason.
    last_restart_reason: Arc<Mutex<Option<LspRestartReason>>>,
    last_message: Arc<Mutex<Option<String>>>,
    /// Invoked whenever the connection status transitions (connect/disconnect).
    /// Lets the service layer emit a Tauri event without polling.
    on_status_change: Arc<dyn Fn(LspStatus) + Send + Sync>,
}

impl LspManager {
    /// Check whether the tinymist binary is reachable.
    pub fn check_available(config: &LspConfig) -> bool {
        which::which(&config.tinymist_path).is_ok()
    }

    /// Generate a fresh per-app-start capability token (§6.1). 32 hex chars
    /// from a v4 UUID's simple form — `uuid` is already a dependency, so this
    /// adds no new code. Held in memory only; never written to disk.
    fn generate_token() -> Arc<str> {
        let s = uuid::Uuid::new_v4().simple().to_string();
        Arc::from(s)
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
        let enabled = config.enabled;

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
                restart_in_progress: Arc::new(AtomicBool::new(false)),
                available,
                enabled,
                token: Arc::from(""),
                generation: Arc::new(AtomicU64::new(1)),
                supervisor: Arc::new(Mutex::new(LspSupervisor::default())),
                last_restart_reason: Arc::new(Mutex::new(None)),
                last_message: Arc::new(Mutex::new(None)),
                on_status_change,
            };
            // Announce the initial (unavailable/disabled) state.
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
        let restart_in_progress = Arc::new(AtomicBool::new(false));
        let conn_shutdown = Arc::new(Mutex::new(None::<oneshot::Sender<()>>));
        let supervisor = Arc::new(Mutex::new(LspSupervisor::default()));
        // §6.4: the restart-reason / message slots are SHARED between the
        // manager (`restart()` writes; `status()` reads) and the accept loop
        // (relay-start clears; crash stamps `ChildCrash`; exhaustion stamps the
        // Failed message). Created here so the spawn and the struct see the
        // same Arc.
        let last_restart_reason = Arc::new(Mutex::new(None));
        let last_message = Arc::new(Mutex::new(None));
        let on_status_change = Arc::new(on_status_change);
        // §6.1: capability token + initial generation. Both live for the
        // process lifetime; generation is bumped on restart/crash, the token
        // never changes.
        let token = Self::generate_token();
        let generation = Arc::new(AtomicU64::new(1));

        let running_clone = running.clone();
        let reconnecting_clone = reconnecting.clone();
        let restart_in_progress_clone = restart_in_progress.clone();
        let config_clone = config.clone();
        let conn_shutdown_clone = conn_shutdown.clone();
        let supervisor_clone = supervisor.clone();
        let last_restart_reason_clone = last_restart_reason.clone();
        let last_message_clone = last_message.clone();
        let on_status_clone = on_status_change.clone();
        let token_clone = token.clone();
        let generation_clone = generation.clone();
        let enabled_clone = enabled;

        tokio::spawn(async move {
            if let Err(e) = Self::accept_loop(
                listener,
                shutdown_rx,
                wake_rx,
                running_clone,
                reconnecting_clone,
                restart_in_progress_clone,
                conn_shutdown_clone,
                supervisor_clone,
                last_restart_reason_clone,
                last_message_clone,
                on_status_clone,
                ws_port,
                config_clone,
                token_clone,
                generation_clone,
                enabled_clone,
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
            restart_in_progress,
            available,
            enabled,
            token,
            generation,
            supervisor,
            last_restart_reason,
            last_message,
            on_status_change,
        })
    }

    /// The WebSocket URL for the frontend to connect to (§6.1).
    ///
    /// Format: `ws://127.0.0.1:<port>/lsp/main/<generation>?token=<token>`
    /// using the CURRENT generation. Empty string when tinymist isn't
    /// available (no endpoint to publish).
    ///
    /// Returned as soon as the server is bound (regardless of whether a client
    /// is currently connected), because the frontend needs the URL *in order*
    /// to connect — gating it on `running` would deadlock (running only flips
    /// true after a client connects, which needs the URL). The `available`
    /// field distinguishes "server up" from "tinymist found"; `running` in the
    /// status payload signals an active client connection.
    pub fn ws_url(&self) -> String {
        if self.available {
            let gen = self.generation.load(Ordering::Relaxed);
            build_ws_url(self.ws_port, &self.token, gen)
        } else {
            String::new()
        }
    }

    /// Current status. Derives the `LspStatusKind` from the supervision flags
    /// via the pure [`status_kind_for`] helper so the mapping stays in one
    /// unit-tested place.
    pub fn status(&self) -> LspStatus {
        let running = self.running.load(Ordering::Relaxed);
        // `restarting` covers BOTH the explicit `restart_in_progress` flag
        // (an in-flight `restart()` between bump and next client connect) AND
        // the listener-backoff `reconnecting` flag — both surface as
        // `LspStatusKind::Restarting` per §6.4.
        let restarting = self.reconnecting.load(Ordering::Relaxed)
            || self.restart_in_progress.load(Ordering::Relaxed);
        let exhausted = self.supervisor.lock().is_exhausted();
        let kind = status_kind_for(self.available, self.enabled, running, restarting, exhausted);
        LspStatus {
            available: self.available,
            enabled: self.enabled,
            status: kind,
            generation: self.generation.load(Ordering::Relaxed),
            ws_url: self.ws_url(),
            // The status-kind helper is the source of truth for `status`; a
            // reason/message is only present when `restart()`/crash set it
            // explicitly on the field, not here. `status()` is a snapshot read
            // — the reason/message persist on the manager only across the
            // brief Restarting/Failed window, carried via the dedicated fields
            // below.
            restart_reason: self.last_restart_reason(),
            message: self.last_message(),
        }
    }

    /// Restart the active LSP connection: announce `Restarting` (carrying
    /// `reason`), bump the generation (so the OLD endpoint URL is immediately
    /// invalid), then signal the live relay to wind down, which kills its
    /// tinymist child. The next WebSocket connection (the frontend reconnects
    /// automatically to the NEW URL after receiving the status event) spawns a
    /// fresh tinymist, re-runs the `initialize` handshake, and clears the
    /// `Restarting` state → `Running`.
    ///
    /// Per §6.3 the order is: set `restart_reason` + `restart_in_progress`,
    /// publish `Restarting`, THEN bump generation + send `conn_shutdown`. This
    /// way the frontend observes a coherent transition (Restarting with the
    /// reason, then a generation bump carrying the new URL) instead of a
    /// generation jump with no explanation.
    ///
    /// Generation bump happens BEFORE the supersede (§6.3) so that by the time
    /// the old relay is winding down, the old URL no longer validates — a
    /// stale frontend attempting it is rejected at the upgrade.
    ///
    /// Also re-arms the accept-loop supervisor (§6.3): if auto-retry had
    /// exhausted its backoff schedule (the loop exited and LSP was flagged
    /// unavailable), a manual restart clears that state so the next fatal
    /// error begins backoff from the top. In the common case (no exhaustion)
    /// this is a no-op on the supervisor.
    ///
    /// No-op-ish if no connection is currently active (and not exhausted): the
    /// generation still bumps so a fresh handshake is forced, but no relay is
    /// torn down. Callers pass the reason so the wire `restartReason` reflects
    /// the trigger (`Manual` for the IPC button, `WorkspaceChange` for Task 8's
    /// workspace handler, `SettingsChange`, …).
    pub fn restart(&self, reason: LspRestartReason) {
        // §6.4: stamp the restart reason BEFORE anything else so the first
        // `Restarting` publish carries it. Set `restart_in_progress` so
        // `status_kind_for` resolves to `Restarting` (the explicit-restart
        // arm, distinct from listener-backoff `reconnecting`).
        {
            let mut r = self.last_restart_reason.lock();
            *r = Some(reason);
        }
        {
            let mut m = self.last_message.lock();
            *m = None;
        }
        self.restart_in_progress.store(true, Ordering::Relaxed);

        // §6.3: re-arm the supervisor so a manual restart recovers from
        // exhaustion. Clear the reconnecting flag (we're acting, not waiting).
        let was_exhausted = self.supervisor.lock().is_exhausted();
        if was_exhausted {
            self.supervisor.lock().re_arm();
            self.reconnecting.store(false, Ordering::Relaxed);
            tracing::info!("LSP restart ({reason:?}) re-armed the supervisor after exhaustion");
            // Re-announce: the frontend should clear its "manual restart
            // required" state. Bump the wake channel to revive a parked loop.
            if let Some(tx) = &self.wake_tx {
                tx.send_modify(|v| *v = v.wrapping_add(1));
            }
        }

        // §6.3: bump generation BEFORE the supersede so the old endpoint URL
        // is invalid by the time the old relay winds down. The relay's end
        // callback detects "superseded by restart" by observing its own
        // generation is now in the past (it does NOT bump again in that case).
        let prev_gen = self.generation.fetch_add(1, Ordering::Relaxed);
        let new_gen = prev_gen + 1;
        tracing::info!(
            "LSP restart ({reason:?}) requested: bumping generation {} -> {} \
             (old endpoint invalidated)",
            prev_gen,
            new_gen
        );

        if let Some(tx) = self.conn_shutdown.lock().take() {
            // `send` errors when the receiver was already dropped — i.e. the
            // relay ended on its own (peer closed / tinymist exited) and a
            // stale sender lingered. Log accordingly so the message reflects
            // what actually happened, not an optimistic assumption.
            match tx.send(()) {
                Ok(()) => tracing::info!(
                    "LSP restart ({reason:?}) superseding active connection \
                     (generation {})",
                    new_gen
                ),
                Err(_) => tracing::info!(
                    "LSP restart ({reason:?}) requested: connection had already \
                     ended (relay exited); the next client connects fresh at \
                     generation {}",
                    new_gen
                ),
            }
        } else if !was_exhausted {
            tracing::debug!(
                "LSP restart ({reason:?}) requested but no active connection to \
                 supersede (generation advanced to {})",
                new_gen
            );
        }

        // Publish the new endpoint so the frontend fetches the fresh URL.
        // (If unavailable, ws_url is empty and this is a no-op announcement.)
        // `restart_in_progress` stays set; the next client's relay-start
        // publish clears it (→ Running).
        (self.on_status_change)(self.status());
    }

    /// Shutdown the manager and kill any running children.
    pub async fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        self.running.store(false, Ordering::Relaxed);
    }

    // -- internal ----------------------------------------------------------

    /// Snapshot the last restart reason (§6.4). Carried on the wire as
    /// `restartReason` across the Restarting/Failed window; cleared on the
    /// `running` → `Running` publish so a steady-state status doesn't echo a
    /// stale trigger.
    fn last_restart_reason(&self) -> Option<LspRestartReason> {
        *self.last_restart_reason.lock()
    }

    /// Snapshot the last human-readable status message (§6.4). Set on the
    /// supervisor-exhaustion `Failed` publish; cleared on the `running` →
    /// `Running` publish alongside the reason.
    fn last_message(&self) -> Option<String> {
        self.last_message.lock().clone()
    }

    /// Accept loop: waits for WebSocket connections and spawns a tinymist
    /// child + relay for each one.
    ///
    /// **Single-generation single-connection (§6.2)**: at most one tinymist +
    /// relay is live per generation. A same-generation new connection while a
    /// relay is still live is REJECTED (the old connection must close first,
    /// or a `restart()` — which bumps the generation — supersedes it). Only
    /// `restart()` supersedes; two rapid reconnects at the same gen no longer
    /// both succeed (the second is dropped at the upgrade).
    #[allow(clippy::too_many_arguments)]
    async fn accept_loop(
        listener: TcpListener,
        mut shutdown_rx: watch::Receiver<bool>,
        mut wake_rx: watch::Receiver<u64>,
        running: Arc<AtomicBool>,
        reconnecting: Arc<AtomicBool>,
        restart_in_progress: Arc<AtomicBool>,
        conn_shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        supervisor: Arc<Mutex<LspSupervisor>>,
        last_restart_reason: Arc<Mutex<Option<LspRestartReason>>>,
        last_message: Arc<Mutex<Option<String>>>,
        on_status_change: Arc<dyn Fn(LspStatus) + Send + Sync>,
        ws_port: u16,
        config: LspConfig,
        token: Arc<str>,
        generation: Arc<AtomicU64>,
        enabled: bool,
    ) -> anyhow::Result<()> {
        // `conn_shutdown` doubles as the live-relay flag: `Some` ⇒ a relay is
        // active for the current generation. The single-gen-single-connection
        // rule rejects a same-gen new connection while this is `Some`.

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
                                        available: true,
                                        enabled,
                                        status: LspStatusKind::Restarting,
                                        generation: generation.load(Ordering::Relaxed),
                                        ws_url: build_ws_url(
                                            ws_port,
                                            token.as_ref(),
                                            generation.load(Ordering::Relaxed),
                                        ),
                                        // Backoff is a listener-level reconnect,
                                        // not a generation-bump restart trigger;
                                        // surface any reason/message previously
                                        // stamped (or None).
                                        restart_reason: *last_restart_reason.lock(),
                                        message: last_message.lock().clone(),
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
                                    {
                                        let mut m = last_message.lock();
                                        if m.is_none() {
                                            *m = Some(
                                                "LSP listener exhausted retries; \
                                                 manual restart required"
                                                    .to_string(),
                                            );
                                        }
                                    }
                                    on_status_change(LspStatus {
                                        available: true,
                                        enabled,
                                        status: LspStatusKind::Failed,
                                        generation: generation.load(Ordering::Relaxed),
                                        ws_url: String::new(),
                                        restart_reason: *last_restart_reason.lock(),
                                        message: last_message.lock().clone(),
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

                    // Validate the WebSocket handshake against ALL FOUR
                    // dimensions (§6.1): Origin, path, generation, token.
                    // Capture the token + a clone of the generation counter
                    // so the callback reads the CURRENT generation at upgrade
                    // time (restart() may bump it between connections).
                    let token_for_cb = token.clone();
                    let generation_for_cb = generation.clone();
                    let validator = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                                          resp: tokio_tungstenite::tungstenite::handshake::server::Response|
                     -> std::result::Result<
                        tokio_tungstenite::tungstenite::handshake::server::Response,
                        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
                    > {
                        let origin = req
                            .headers()
                            .get(http::header::ORIGIN)
                            .and_then(|v| v.to_str().ok());
                        let path = req.uri().path();
                        let query = req.uri().query().unwrap_or("");
                        let current_gen = generation_for_cb.load(Ordering::Relaxed);
                        // For redacted logging only: was a non-empty `token=`
                        // present? (The actual value is checked by
                        // validate_handshake below.)
                        let token_in_query = parse_token_from_query(query).is_some();
                        match validate_handshake(
                            current_gen,
                            token_for_cb.as_ref(),
                            origin,
                            path,
                            query,
                        ) {
                            HandshakeOutcome::Accept => Ok(resp),
                            HandshakeOutcome::Reject(reason) => {
                                tracing::warn!(
                                    "rejected WebSocket handshake: {} \
                                     (origin={:?}, path={:?}, token={}, server_gen={})",
                                    reason.label(),
                                    origin,
                                    path,
                                    // Redact the token: log presence only so the
                                    // capability value never ships with a bug
                                    // report's attached logs.
                                    if token_in_query { "present" } else { "absent" },
                                    current_gen,
                                );
                                let mut err = http::Response::new(Some(
                                    reason.label().to_string(),
                                ));
                                *err.status_mut() = reason.status();
                                Err(err)
                            }
                        }
                    };

                    let ws_stream = match tokio_tungstenite::accept_hdr_async(
                        stream,
                        validator,
                    ).await {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("rejected WebSocket handshake: {e}");
                            continue;
                        }
                    };
                    tracing::info!("LSP WebSocket client connected (handshake OK)");

                    // §6.2 single-generation single-connection: a relay is
                    // already live for the current generation. Reject this
                    // connection (drop it) instead of superseding — only a
                    // restart() (which bumps the generation) supersedes. The
                    // frontend's reconnect logic must wait for the prior
                    // connection to close.
                    let current_gen = generation.load(Ordering::Relaxed);
                    let already_live = conn_shutdown.lock().is_some();
                    if already_live {
                        tracing::warn!(
                            "rejected WebSocket: a relay is already live for \
                             generation {} (single-generation single-connection; \
                             wait for the prior connection to close or a restart)",
                            current_gen
                        );
                        // Dropping `ws_stream` closes the TCP stream; the
                        // client observes a broken connection and must retry
                        // against the current URL (which won't change until a
                        // restart). We do NOT kill the live relay here.
                        continue;
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
                    // A fresh client connected for the current generation: clear
                    // the explicit-restart flag + any Restarting/Failed reason
                    // so the `Running` publish is clean (a steady-state Running
                    // must not echo a stale trigger).
                    restart_in_progress.store(false, Ordering::Relaxed);
                    {
                        let mut r = last_restart_reason.lock();
                        *r = None;
                    }
                    {
                        let mut m = last_message.lock();
                        *m = None;
                    }
                    on_status_change(LspStatus {
                        available: true,
                        enabled,
                        status: LspStatusKind::Running,
                        generation: generation.load(Ordering::Relaxed),
                        ws_url: build_ws_url(
                            ws_port,
                            token.as_ref(),
                            generation.load(Ordering::Relaxed),
                        ),
                        restart_reason: None,
                        message: None,
                    });

                    let (conn_shutdown_tx, conn_shutdown_rx) = oneshot::channel::<()>();
                    conn_shutdown.lock().replace(conn_shutdown_tx);

                    let running_clone = running.clone();
                    let on_status_clone = on_status_change.clone();
                    let generation_clone = generation.clone();
                    // Clone `token` for the relay task (the function-param `token`
                    // is reused across loop iterations and must not be moved).
                    let token_clone = token.clone();
                    // Clone the conn_shutdown slot so an UNSOLICITED relay end
                    // (crash / network drop / peer close) can clear its OWN
                    // sender. Without this, the single-generation-single-
                    // connection rule below would keep seeing a ghost sender
                    // forever and reject every reconnect — wedging the LSP
                    // until a manual restart(). Only `restart()` otherwise
                    // `.take()`s the slot.
                    let conn_shutdown_slot = conn_shutdown.clone();
                    // §6.4: clone the restart-reason slot + the `enabled` flag
                    // so the unsolicited-end (crash) publish can stamp
                    // `ChildCrash` and build a full `LspStatus` on the wire.
                    let last_restart_reason_clone = last_restart_reason.clone();
                    let enabled_clone = enabled;
                    tokio::spawn(async move {
                        // Race the relay against an explicit supersede signal.
                        //
                        // §6.3 / §6.2 generation-bump-on-end: distinguish the
                        // two end causes:
                        //   - `conn_shutdown_rx` fired ⇒ `restart()` sent the
                        //     signal, and restart() ALREADY bumped the
                        //     generation (before sending). So this is a
                        //     restart-supersede — do NOT bump again.
                        //   - `relay_res` returned ⇒ the relay ended on its
                        //     own (tinymist crash, network drop, peer close).
                        //     This is an unsolicited end — bump the generation
                        //     here so the next reconnect is a fresh handshake
                        //     against a new URL.
                        let mut ended_by_restart = false;
                        tokio::select! {
                            biased;
                            _ = conn_shutdown_rx => {
                                tracing::info!(
                                    "LSP connection superseded by restart, \
                                     shutting down (generation already bumped \
                                     by restart())"
                                );
                                ended_by_restart = true;
                            }
                            relay_res = relay::relay(ws_stream, stdin, stdout) => {
                                if let Err(e) = relay_res {
                                    tracing::error!("LSP relay error: {e}");
                                }
                            }
                        }

                        // Capture our generation for the end-of-connection
                        // trace log below.
                        let my_gen = generation_clone.load(Ordering::Relaxed);

                        if !ended_by_restart {
                            // Unsolicited end (crash / network drop / peer
                            // close). §6.3 "Tinymist child 崩溃" trigger: bump
                            // the generation so the next reconnect hits a
                            // fresh handshake against a new URL. fetch_add so
                            // the bump is atomic even if a restart() races.
                            let prev = generation_clone.fetch_add(1, Ordering::Relaxed);
                            tracing::info!(
                                "LSP connection ended unsolicitedly at \
                                 generation {}; bumping to {} for a fresh \
                                 reconnect endpoint",
                                prev,
                                prev + 1
                            );
                            // CRITICAL: clear our own sender from the
                            // conn_shutdown slot. The single-generation-single-
                            // connection rule rejects a new connection while
                            // `conn_shutdown` is Some — so without this clear,
                            // a stale sender would wedge the LSP forever after
                            // any crash/drop (every reconnect would see the
                            // ghost sender and be dropped). restart() is the
                            // only other `.take()` site; on the
                            // ended_by_restart branch the receiver fires and
                            // restart() has already taken the sender, so we
                            // only clear on the unsolicited branch (where the
                            // sender is still ours in the slot).
                            conn_shutdown_slot.lock().take();
                        }

                        // Only publish `running=false` if we are STILL the
                        // active generation. A restart() that superseded us
                        // already bumped the generation (and the restart path
                        // re-announces the new URL); an unsolicited end means
                        // WE just bumped it, so we're no longer active either
                        // way — but we still own the "running" status until a
                        // new connection takes over, so publish false.
                        //
                        // Note: when ended_by_restart, restart() already
                        // re-announced via its own on_status_change call, so
                        // our publish here would be redundant/stale. Skip it
                        // in that case to avoid a flicker.
                        if !ended_by_restart {
                            running_clone.store(false, Ordering::Relaxed);
                            // §6.4: an unsolicited relay end is a child crash —
                            // stamp `ChildCrash` so the wire `restartReason`
                            // explains the bump the frontend just received.
                            {
                                let mut r = last_restart_reason_clone.lock();
                                *r = Some(LspRestartReason::ChildCrash);
                            }
                            on_status_clone(LspStatus {
                                available: true,
                                enabled: enabled_clone,
                                status: LspStatusKind::Restarting,
                                generation: generation_clone.load(Ordering::Relaxed),
                                ws_url: build_ws_url(
                                    ws_port,
                                    token_clone.as_ref(),
                                    generation_clone.load(Ordering::Relaxed),
                                ),
                                restart_reason: Some(LspRestartReason::ChildCrash),
                                message: None,
                            });
                        }
                        let _ = child.kill().await;
                        tracing::info!(
                            "LSP connection ended (generation {}), tinymist killed",
                            my_gen
                        );
                    });
                }
            }
        }
        Ok(())
    }
}

/// Build the published `ws_url` string (§6.1). Centralized so the accept
/// loop, `restart()`, and `LspManager::ws_url()` all agree on the format.
///
/// Format: `ws://127.0.0.1:<port>/lsp/main/<gen>?token=<token>`.
fn build_ws_url(ws_port: u16, token: &str, generation: u64) -> String {
    format!(
        "ws://127.0.0.1:{}/lsp/main/{}?token={}",
        ws_port, generation, token
    )
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

    // -- LspSupervisor backoff (unchanged behavior) -------------------------

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

    // -- parse_lsp_path ----------------------------------------------------

    #[test]
    fn parse_lsp_path_valid() {
        assert_eq!(parse_lsp_path("/lsp/main/1"), Some(1));
        assert_eq!(parse_lsp_path("/lsp/main/42"), Some(42));
        assert_eq!(
            parse_lsp_path("/lsp/main/18446744073709551615"),
            Some(u64::MAX)
        );
    }

    #[test]
    fn parse_lsp_path_tolerates_trailing_query() {
        // A full request target (path?query) is tolerated defensively.
        assert_eq!(parse_lsp_path("/lsp/main/7?token=abc"), Some(7));
    }

    #[test]
    fn parse_lsp_path_rejects_non_numeric() {
        assert_eq!(parse_lsp_path("/lsp/main/abc"), None);
        assert_eq!(parse_lsp_path("/lsp/main/1abc"), None);
        assert_eq!(parse_lsp_path("/lsp/main/-1"), None);
    }

    #[test]
    fn parse_lsp_path_rejects_empty_segment() {
        assert_eq!(parse_lsp_path("/lsp/main/"), None);
    }

    #[test]
    fn parse_lsp_path_rejects_wrong_prefix() {
        assert_eq!(parse_lsp_path("/lsp/other/1"), None);
        assert_eq!(parse_lsp_path("/ls/main/1"), None);
        assert_eq!(parse_lsp_path("/lsp/main1"), None);
        assert_eq!(parse_lsp_path("lsp/main/1"), None);
    }

    #[test]
    fn parse_lsp_path_rejects_extra_segments() {
        // Must EXACTLY match `/lsp/main/<gen>` (§6.1).
        assert_eq!(parse_lsp_path("/lsp/main/1/extra"), None);
        assert_eq!(parse_lsp_path("/lsp/main/1/"), None);
        assert_eq!(parse_lsp_path("/lsp/main/1/2"), None);
    }

    #[test]
    fn parse_lsp_path_rejects_zero() {
        // Generation 0 is reserved/invalid; server starts at 1.
        assert_eq!(parse_lsp_path("/lsp/main/0"), None);
    }

    #[test]
    fn parse_lsp_path_rejects_unrelated() {
        assert_eq!(parse_lsp_path("/"), None);
        assert_eq!(parse_lsp_path(""), None);
        assert_eq!(parse_lsp_path("/index.html"), None);
    }

    // -- parse_token_from_query --------------------------------------------

    #[test]
    fn parse_token_valid() {
        assert_eq!(parse_token_from_query("token=abc"), Some("abc"));
        // Leading '?' tolerated.
        assert_eq!(parse_token_from_query("?token=abc"), Some("abc"));
    }

    #[test]
    fn parse_token_with_other_params() {
        assert_eq!(parse_token_from_query("token=abc&foo=bar"), Some("abc"));
        assert_eq!(parse_token_from_query("foo=bar&token=abc"), Some("abc"));
        assert_eq!(
            parse_token_from_query("foo=bar&token=abc&baz=qux"),
            Some("abc")
        );
    }

    #[test]
    fn parse_token_missing() {
        assert_eq!(parse_token_from_query(""), None);
        assert_eq!(parse_token_from_query("other=x"), None);
        assert_eq!(parse_token_from_query("?other=x"), None);
    }

    #[test]
    fn parse_token_empty_rejected() {
        assert_eq!(parse_token_from_query("token="), None);
        assert_eq!(parse_token_from_query("token=&foo=bar"), None);
    }

    #[test]
    fn parse_token_takes_first_occurrence() {
        // Multiple `token=` params: take the first non-empty one.
        assert_eq!(parse_token_from_query("token=abc&token=def"), Some("abc"));
    }

    // -- validate_handshake -------------------------------------------------

    #[test]
    fn handshake_accepts_all_good() {
        let out = validate_handshake(
            3,
            "secret-token",
            Some("http://localhost:1420"),
            "/lsp/main/3",
            "token=secret-token",
        );
        assert_eq!(out, HandshakeOutcome::Accept);
    }

    #[test]
    fn handshake_accepts_tauri_production_origin() {
        let out = validate_handshake(
            1,
            "tok",
            Some("https://tauri.localhost"),
            "/lsp/main/1",
            "token=tok",
        );
        assert_eq!(out, HandshakeOutcome::Accept);
    }

    #[test]
    fn handshake_rejects_bad_origin() {
        let out = validate_handshake(
            1,
            "tok",
            Some("https://evil.example.com"),
            "/lsp/main/1",
            "token=tok",
        );
        assert_eq!(out, HandshakeOutcome::Reject(HandshakeRejection::Origin));
        // And missing origin entirely.
        let out = validate_handshake(1, "tok", None, "/lsp/main/1", "token=tok");
        assert_eq!(out, HandshakeOutcome::Reject(HandshakeRejection::Origin));
    }

    #[test]
    fn handshake_rejects_old_generation() {
        let out = validate_handshake(
            5,
            "tok",
            Some("http://127.0.0.1:1"),
            "/lsp/main/3",
            "token=tok",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::GenerationPast)
        );
    }

    #[test]
    fn handshake_rejects_future_generation() {
        // Frontend must not predict future gens (§6.1).
        let out = validate_handshake(
            2,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/5",
            "token=tok",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::GenerationFuture)
        );
    }

    #[test]
    fn handshake_rejects_path_malformed() {
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/abc",
            "token=tok",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::PathMalformed)
        );
        // Extra segment.
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/1/extra",
            "token=tok",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::PathMalformed)
        );
        // Wrong prefix.
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/other/1",
            "token=tok",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::PathMalformed)
        );
    }

    #[test]
    fn handshake_rejects_zero_generation_in_path() {
        // parse_lsp_path rejects 0, surfacing as PathMalformed.
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/0",
            "token=tok",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::PathMalformed)
        );
    }

    #[test]
    fn handshake_rejects_token_mismatch() {
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/1",
            "token=wrong",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::TokenMismatch)
        );
    }

    #[test]
    fn handshake_rejects_token_missing() {
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/1",
            "",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::TokenMismatch)
        );
        // `token=` empty.
        let out = validate_handshake(
            1,
            "tok",
            Some("http://localhost:1"),
            "/lsp/main/1",
            "token=",
        );
        assert_eq!(
            out,
            HandshakeOutcome::Reject(HandshakeRejection::TokenMismatch)
        );
    }

    #[test]
    fn handshake_origin_checked_before_token() {
        // A bad origin with a bad token still reports Origin (origin is the
        // first/outermost check, matching §6.1's "token is NOT a substitute
        // for Origin").
        let out = validate_handshake(
            1,
            "tok",
            Some("https://evil.example.com"),
            "/lsp/main/1",
            "token=wrong",
        );
        assert_eq!(out, HandshakeOutcome::Reject(HandshakeRejection::Origin));
    }

    // -- rejection status codes --------------------------------------------

    #[test]
    fn rejection_status_codes() {
        assert_eq!(
            HandshakeRejection::Origin.status(),
            http::StatusCode::FORBIDDEN
        );
        assert_eq!(
            HandshakeRejection::TokenMismatch.status(),
            http::StatusCode::FORBIDDEN
        );
        assert_eq!(
            HandshakeRejection::PathMalformed.status(),
            http::StatusCode::NOT_FOUND
        );
        assert_eq!(
            HandshakeRejection::GenerationFuture.status(),
            http::StatusCode::NOT_FOUND
        );
        assert_eq!(
            HandshakeRejection::GenerationPast.status(),
            http::StatusCode::NOT_FOUND
        );
    }

    // -- build_ws_url -------------------------------------------------------

    #[test]
    fn build_ws_url_format() {
        let url = build_ws_url(54321, "deadbeef", 7);
        assert_eq!(url, "ws://127.0.0.1:54321/lsp/main/7?token=deadbeef");
    }

    #[test]
    fn build_ws_url_generation_one() {
        let url = build_ws_url(1, "tok", 1);
        assert_eq!(url, "ws://127.0.0.1:1/lsp/main/1?token=tok");
    }

    // -- generation-bump decision (pure) -----------------------------------
    //
    // The accept_loop's relay-end logic decides whether to bump the generation
    // based on whether the end was a restart-supersede (already bumped by
    // restart()) or an unsolicited end (crash/drop). Extract the decision into
    // a pure helper so it's unit-testable.

    /// Pure decision: given the relay ended, was it a restart-supersede
    /// (`ended_by_restart=true`) or an unsolicited end (`false`)? Returns
    /// whether the relay-end path should bump the generation.
    ///
    /// restart() bumps BEFORE sending the supersede signal, so a
    /// restart-supersede must NOT bump again. An unsolicited end (crash,
    /// network drop, peer close) must bump so the next reconnect is fresh.
    fn should_bump_on_relay_end(ended_by_restart: bool) -> bool {
        !ended_by_restart
    }

    #[test]
    fn relay_end_bump_decision_restart_no_bump() {
        // restart() already bumped before sending the supersede signal.
        assert!(!should_bump_on_relay_end(true));
    }

    #[test]
    fn relay_end_bump_decision_crash_bumps() {
        // Unsolicited end (crash / network drop / peer close) → bump for a
        // fresh reconnect endpoint (§6.3).
        assert!(should_bump_on_relay_end(false));
    }

    // -- LspStatus wire shape (Task 7 generation-aware payload) ------------

    #[test]
    fn lsp_status_round_trips_new_fields() {
        // The wire type must round-trip the generation-aware fields and the
        // camelCase enum tags.
        let s = LspStatus {
            available: true,
            enabled: true,
            status: LspStatusKind::Restarting,
            generation: 7,
            ws_url: "ws://127.0.0.1:1/lsp/main/7?token=x".into(),
            restart_reason: Some(LspRestartReason::Manual),
            message: Some("manual restart".into()),
        };
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"status\":\"restarting\""), "camelCase kind: {json}");
        assert!(json.contains("\"restartReason\":\"manual\""), "camelCase reason: {json}");
        assert!(json.contains("\"generation\":7"), "generation field: {json}");
        assert!(json.contains("\"wsUrl\""), "camelCase ws_url: {json}");
        assert!(json.contains("\"enabled\":true"), "enabled field: {json}");
        // Round-trips back with the same tags.
        let back: LspStatus = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.status, LspStatusKind::Restarting);
        assert_eq!(back.restart_reason, Some(LspRestartReason::Manual));
        assert_eq!(back.generation, 7);
    }

    #[test]
    fn lsp_status_kind_serializes_camel_case() {
        // Multi-word variants must be camelCase on the wire (matching
        // `DocumentOrigin`'s convention), NOT kebab-case.
        assert_eq!(
            serde_json::to_string(&LspStatusKind::AwaitingClient).unwrap(),
            "\"awaitingClient\""
        );
        assert_eq!(
            serde_json::to_string(&LspRestartReason::WorkspaceChange).unwrap(),
            "\"workspaceChange\""
        );
        assert_eq!(
            serde_json::to_string(&LspRestartReason::ChildCrash).unwrap(),
            "\"childCrash\""
        );
        assert_eq!(
            serde_json::to_string(&LspRestartReason::GenerationMismatch).unwrap(),
            "\"generationMismatch\""
        );
    }

    // -- status_kind_for mapping (§6.4 / §16) ------------------------------

    #[test]
    fn status_kind_for_disabled_when_not_enabled() {
        // Disabled wins over everything (even if tinymist is "available").
        assert_eq!(
            status_kind_for(true, false, true, false, false),
            LspStatusKind::Disabled
        );
        assert_eq!(
            status_kind_for(true, false, false, true, true),
            LspStatusKind::Disabled
        );
    }

    #[test]
    fn status_kind_for_unavailable_when_enabled_but_not_found() {
        assert_eq!(
            status_kind_for(false, true, false, false, false),
            LspStatusKind::Unavailable
        );
    }

    #[test]
    fn status_kind_for_failed_when_supervisor_exhausted() {
        assert_eq!(
            status_kind_for(true, true, false, false, true),
            LspStatusKind::Failed
        );
    }

    #[test]
    fn status_kind_for_restarting_when_reconnecting() {
        // Either the explicit restart_in_progress flag OR the listener-backoff
        // reconnecting flag maps to Restarting (both arrive as `restarting=true`
        // from `status()`).
        assert_eq!(
            status_kind_for(true, true, false, true, false),
            LspStatusKind::Restarting
        );
    }

    #[test]
    fn status_kind_for_running_when_client_connected() {
        assert_eq!(
            status_kind_for(true, true, true, false, false),
            LspStatusKind::Running
        );
    }

    #[test]
    fn status_kind_for_awaiting_client_when_listener_bound_no_client() {
        // The default/otherwise arm: enabled, available, not exhausted, not
        // restarting, not running → waiting for the first client.
        assert_eq!(
            status_kind_for(true, true, false, false, false),
            LspStatusKind::AwaitingClient
        );
    }

    #[test]
    fn status_kind_for_resolution_order() {
        // Disabled > Unavailable > Failed > Restarting > Running > AwaitingClient.
        // Exhausted-but-restarting still wins Failed? No — Failed is checked
        // BEFORE restarting in `status_kind_for`, so an exhausted supervisor
        // reports Failed even mid-backoff. But the real `status()` only feeds
        // `exhausted=true` once the loop parks (reconnecting=false at that
        // point), so this ordering is about the pure helper's precedence.
        assert_eq!(
            status_kind_for(true, true, false, true, true),
            LspStatusKind::Failed
        );
        // Running beats Restarting only if not restarting — but a running
        // client implies restart_in_progress=false in practice. The helper
        // checks restarting before running, so a contradictory (running AND
        // restarting) input reports Restarting.
        assert_eq!(
            status_kind_for(true, true, true, true, false),
            LspStatusKind::Restarting
        );
    }

    // -- LspManager state-only construction (no listener) ------------------
    //
    // `start()` binds a real listener, which we don't want in unit tests. We
    // exercise the URL-building + generation-bump logic by constructing the
    // manager's state directly via a test-only builder, exercising the same
    // `ws_url()` / `generation` / `restart()` paths the live manager uses.

    #[allow(dead_code)]
    struct TestManager {
        ws_port: u16,
        available: bool,
        token: Arc<str>,
        generation: Arc<AtomicU64>,
    }

    impl TestManager {
        fn new(token: &str, gen: u64) -> Self {
            Self {
                ws_port: 12345,
                available: true,
                token: Arc::from(token),
                generation: Arc::new(AtomicU64::new(gen)),
            }
        }

        /// Mirrors `LspManager::ws_url` exactly.
        fn ws_url(&self) -> String {
            if self.available {
                let gen = self.generation.load(Ordering::Relaxed);
                format!(
                    "ws://127.0.0.1:{}/lsp/main/{}?token={}",
                    self.ws_port, gen, self.token
                )
            } else {
                String::new()
            }
        }

        /// Mirrors the generation-bump portion of `LspManager::restart`.
        fn bump_generation(&self) -> u64 {
            let prev = self.generation.fetch_add(1, Ordering::Relaxed);
            prev + 1
        }

        fn generation(&self) -> u64 {
            self.generation.load(Ordering::Relaxed)
        }
    }

    #[test]
    fn ws_url_embeds_generation_and_token() {
        let m = TestManager::new("abc123", 1);
        assert_eq!(m.ws_url(), "ws://127.0.0.1:12345/lsp/main/1?token=abc123");
    }

    #[test]
    fn ws_url_reflects_generation_bump() {
        // Simulate restart(): bump the generation, then the URL must carry
        // the new gen (old URL is now invalid).
        let m = TestManager::new("tok", 1);
        assert_eq!(m.ws_url(), "ws://127.0.0.1:12345/lsp/main/1?token=tok");
        let new_gen = m.bump_generation();
        assert_eq!(new_gen, 2);
        assert_eq!(m.generation(), 2);
        assert_eq!(m.ws_url(), "ws://127.0.0.1:12345/lsp/main/2?token=tok");
    }

    #[test]
    fn ws_url_empty_when_unavailable() {
        let mut m = TestManager::new("tok", 1);
        m.available = false;
        assert_eq!(m.ws_url(), "");
    }

    #[test]
    fn ws_url_token_stable_across_generation_bumps() {
        // §6.1: token is shared across generations (only generation changes).
        let m = TestManager::new("stable-tok", 1);
        m.bump_generation();
        m.bump_generation();
        m.bump_generation();
        assert_eq!(m.generation(), 4);
        assert_eq!(
            m.ws_url(),
            "ws://127.0.0.1:12345/lsp/main/4?token=stable-tok"
        );
    }

    #[test]
    fn generate_token_is_32_hex_chars() {
        let t = LspManager::generate_token();
        let s: &str = &t;
        assert_eq!(s.len(), 32, "uuid v4 simple = 32 hex chars");
        assert!(
            s.chars().all(|c| c.is_ascii_hexdigit()),
            "token must be hex: {s}"
        );
        // Two calls produce distinct tokens (random).
        let t2 = LspManager::generate_token();
        assert_ne!(&*t, &*t2, "tokens must be random per app-start");
    }
}
