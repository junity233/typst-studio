//! Managed tinymist install — automatic download into `~/.typststudio/`.
//!
//! When tinymist is not on `PATH`, the app can download a matching release
//! from GitHub and run it from a stable, app-owned location instead of asking
//! the user to install anything by hand:
//!
//! ```text
//! ~/.typststudio/tinymist[.exe]     the binary
//! ~/.typststudio/tinymist.version   the installed version, plain text
//! ~/.typststudio/tinymist.download  in-flight download (cleaned up)
//! ~/.typststudio/tinymist.old       previous binary during a swap (cleaned up)
//! ~/.typststudio/tinymist.extracted freshly extracted binary (cleaned up)
//! ```
//!
//! ## Why the triple-target archives (not the bare binaries)
//!
//! The release's bare binaries (`tinymist-win32-x64.exe`, …) carry no
//! checksums; the cargo-dist triple-target archives (`tinymist-x86_64-pc-
//! windows-msvc.zip`, `tinymist-x86_64-apple-darwin.tar.gz`, …) are listed in
//! the release's `sha256.sum` AND are roughly half the size. We therefore
//! download the archive, verify its SHA-256 against `sha256.sum`, and extract
//! the single `tinymist` binary from it. A `--version` smoke test after
//! extraction guards against truncated/corrupted archives that still hash
//! correctly (shouldn't happen, but the cost is one process spawn).
//!
//! ## Wiring
//!
//! [`TinymistInstaller`] lives in [`AppState`](crate::ipc::state::AppState).
//! `lib.rs` triggers [`TinymistInstaller::begin_install`] at startup when the
//! LSP is unavailable and the `lsp.autoDownload` setting is on; the Settings
//! window exposes a manual trigger. On success the `on_installed` callback
//! relaunches the LSP with the managed binary (see `lib.rs`).
//!
//! Progress is broadcast as `tinymist_install` Tauri events carrying the same
//! [`TinymistInstallStatus`] the IPC commands return, so the frontend can seed
//! from a command and then subscribe.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter as _;

use crate::lsp::manager::LspConfig;

/// tinymist release the app downloads. Kept in sync with
/// `TINYMIST_VERSION` in `scripts/fetch-grammar.mjs` (the TextMate grammar is
/// extracted from the same release's VSIX, so the two must not drift).
pub const TINYMIST_VERSION: &str = "0.15.2";

/// GitHub release download base. The per-asset URL is
/// `<base>/download/v<version>/<asset>`.
const RELEASE_BASE: &str = "https://github.com/Myriad-Dreamin/tinymist/releases";

/// The aggregate checksum file shipped with every release. Lines are
/// `<sha256-hex> *<asset-name>` (or with two spaces); only the triple-target
/// archives are listed, which is why we download archives (see module docs).
const SHA_SUMS_ASSET: &str = "sha256.sum";

/// Stall budget for the archive download, applied via reqwest's
/// `read_timeout`: aborts only when NO bytes arrive for this long, and resets
/// on every chunk. Deliberately NOT a total wall-clock budget — connections
/// to GitHub can be throttled to a crawl yet stay alive (a ~30 MB archive at
/// 50 KB/s legitimately takes ~10 min), and killing those mid-download would
/// make the auto-download useless exactly where it's needed most. A dead
/// connection surfaces after this window instead of hanging the install
/// in-progress forever.
const READ_STALL_TIMEOUT: Duration = Duration::from_secs(2 * 60);

/// Budget for the small `sha256.sum` fetch (total — the file is a few KB, so
/// a total deadline can't misfire on a slow-but-alive connection).
const SUMS_TIMEOUT: Duration = Duration::from_secs(30);

/// How many times the download+verify pair is attempted before surfacing the
/// failure (see `run_install`). Dropped connections mid-body are common on
/// flaky routes to GitHub; the auto-download path has nobody watching to hit
/// Retry, so a couple of automatic re-attempts is the difference between
/// "works unattended" and "silently failed".
const DOWNLOAD_ATTEMPTS: u32 = 3;

/// Budget for the `--version` smoke test. A healthy tinymist answers in well
/// under a second; 15 s leaves room for cold-start disk/AV scans on Windows.
const SMOKE_TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Hard cap on the extracted binary (the real binaries are ~60-75 MB).
const MAX_BINARY_BYTES: u64 = 300 * 1024 * 1024;

/// `CREATE_NO_WINDOW` — spawning the smoke-test child from the GUI process
/// must not flash a console window (mirrors the spawn in `manager.rs`).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// User-Agent for GitHub requests. GitHub rejects requests without one.
const USER_AGENT: &str = concat!("typst-studio/", env!("CARGO_PKG_VERSION"));

// ============================================================================
// Pure helpers (unit-tested without any I/O)
// ============================================================================

/// Map a (os, arch) pair — as reportable strings — to the release archive
/// asset name. `None` for combinations the release does not ship (the caller
/// surfaces `Unsupported` and skips auto-download; a user-provided
/// `lsp.tinymistPath` still works everywhere).
pub fn platform_asset_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("tinymist-x86_64-pc-windows-msvc.zip"),
        ("windows", "aarch64") => Some("tinymist-aarch64-pc-windows-msvc.zip"),
        ("macos", "x86_64") => Some("tinymist-x86_64-apple-darwin.tar.gz"),
        ("macos", "aarch64") => Some("tinymist-aarch64-apple-darwin.tar.gz"),
        ("linux", "x86_64") => Some("tinymist-x86_64-unknown-linux-gnu.tar.gz"),
        ("linux", "aarch64") => Some("tinymist-aarch64-unknown-linux-gnu.tar.gz"),
        // Rust's `arm` target on Linux (armv6/armv7 gnueabihf boards).
        ("linux", "arm") => Some("tinymist-arm-unknown-linux-gnueabihf.tar.gz"),
        _ => None,
    }
}

/// The archive asset for the CURRENT platform, or `None` when unsupported.
pub fn platform_asset() -> Option<&'static str> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    platform_asset_for(os, arch)
}

/// The file name of the tinymist binary inside the archive / on disk.
pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "tinymist.exe"
    } else {
        "tinymist"
    }
}

/// Absolute URL of a release asset.
pub fn asset_url(version: &str, asset: &str) -> String {
    format!("{RELEASE_BASE}/download/v{version}/{asset}")
}

/// Find `asset`'s expected SHA-256 in a `sha256.sum` payload. Handles both
/// the `<hex> *<name>` (binary-mode) and `<hex>  <name>` (text-mode) line
/// shapes; returns the 32 decoded bytes. Malformed lines are skipped, not
/// fatal — the release file is machine-generated, but a missing match must
/// read as "not listed" rather than "unparseable".
pub fn parse_sha_sums(text: &str, asset: &str) -> Option<[u8; 32]> {
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        // sha256sum shape: exactly 64 hex chars, a separator, then the name
        // (a leading `*` marks binary mode on some platforms).
        if line.len() < 66 {
            continue;
        }
        // Boundary-safe split: the body passed through `from_utf8_lossy`, so
        // corrupted bytes become multi-byte U+FFFD and byte 64 can land
        // mid-char — `split_at` would panic there (inside a spawned task,
        // silently wedging the installer). `str::get` returns `None` instead
        // and the malformed line is skipped like any other.
        let (Some(hex), Some(rest)) = (line.get(..64), line.get(64..)) else {
            continue;
        };
        if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = rest.trim_start_matches(['*', ' ', '\t']);
        if name == asset {
            return hex_to_32(hex);
        }
    }
    None
}

/// Decode a 64-char hex string into 32 bytes.
fn hex_to_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// The stable managed-install directory `~/.typststudio/` and the paths under
/// it. `None` when the home dir cannot be resolved (extremely rare; the
/// installer reports a failure rather than crashing).
#[derive(Debug, Clone)]
pub struct InstallPaths {
    pub dir: PathBuf,
    pub binary: PathBuf,
    pub version_file: PathBuf,
    pub download_tmp: PathBuf,
    /// Where the previous binary is parked during a swap (the running exe
    /// can be renamed away even while in use; on Unix a plain rename would
    /// destroy it before the smoke test clears the new one).
    pub old_binary: PathBuf,
}

impl InstallPaths {
    pub fn under_home() -> Option<Self> {
        let home = home_dir()?;
        let dir = home.join(".typststudio");
        let binary = dir.join(binary_name());
        Some(Self {
            version_file: dir.join("tinymist.version"),
            download_tmp: dir.join(format!("{}.download", binary_name())),
            old_binary: dir.join(format!("{}.old", binary_name())),
            dir,
            binary,
        })
    }
}

/// The user's home directory (`%USERPROFILE%` on Windows, `$HOME` on Unix).
/// Resolved from the environment — same approach as `crate::paths`, which
/// documents why some hooks run before `app.path()` is usable.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// The managed binary path when a previous install left one on disk.
/// Purely an existence probe; the `--version` smoke test at install time is
/// what guarantees the file is actually runnable.
pub fn installed_binary() -> Option<PathBuf> {
    let paths = InstallPaths::under_home()?;
    paths.binary.is_file().then_some(paths.binary)
}

/// Resolve the tinymist binary the LSP should spawn. Order:
/// 1. a non-empty `lsp.tinymistPath` setting (user override),
/// 2. the managed install under `~/.typststudio/`,
/// 3. plain `tinymist` (whatever `PATH` yields — may be nothing).
pub fn resolve_tinymist_path(custom: &str) -> String {
    let custom = custom.trim();
    if !custom.is_empty() {
        return custom.to_string();
    }
    installed_binary()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tinymist".into())
}

/// Build the full [`LspConfig`] from the current settings + managed install.
/// Called at app start and again on every relaunch (an install completing, a
/// `lsp.*` setting change) so the manager always sees the fresh resolution.
pub fn resolve_lsp_config(settings: &crate::settings::SettingsService) -> LspConfig {
    let custom: String = settings.get("lsp.tinymistPath", String::new());
    LspConfig {
        tinymist_path: resolve_tinymist_path(&custom),
        enabled: true,
    }
}

// ============================================================================
// Wire types
// ============================================================================

/// Lifecycle state of the managed install, serialized camelCase to match the
/// other wire enums (see `LspStatusKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum TinymistInstallState {
    /// No release asset ships for this platform; auto-download is off the
    /// table (a manual `lsp.tinymistPath` still works).
    Unsupported,
    /// Nothing installed and nothing running.
    NotInstalled,
    /// Archive download in flight (`receivedBytes`/`totalBytes` for progress).
    Downloading,
    /// Download finished; verifying checksum, extracting, smoke-testing.
    Verifying,
    /// A runnable binary is in place at `installedPath`.
    Installed,
    /// The last attempt failed; `error` says why. A new attempt may succeed.
    Failed,
}

/// Snapshot of the managed-install state, broadcast as the `tinymist_install`
/// event payload and returned by the IPC commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct TinymistInstallStatus {
    pub state: TinymistInstallState,
    /// True while an install attempt owns the slot (guards double triggers).
    pub in_progress: bool,
    /// The version an install targets / just installed.
    pub target_version: String,
    /// Bytes of the archive received so far (0 unless downloading).
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub received_bytes: u64,
    /// Total archive bytes when `Content-Length` was present, else 0.
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub total_bytes: u64,
    /// Version of the binary currently on disk, when installed.
    pub installed_version: Option<String>,
    /// Absolute path of the managed binary, when installed.
    pub installed_path: Option<String>,
    /// Human-readable failure reason (state == failed).
    pub error: Option<String>,
}

/// Installer-internal bookkeeping. `installed_*` is probed lazily from disk on
/// snapshot so a user deleting `~/.typststudio/` is reflected without an
/// event.
#[derive(Debug, Default, Clone)]
struct InstallState {
    state: Option<TinymistInstallState>,
    received_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

impl InstallState {
    fn kind(&self) -> TinymistInstallState {
        self.state.unwrap_or(if platform_asset().is_some() {
            TinymistInstallState::NotInstalled
        } else {
            TinymistInstallState::Unsupported
        })
    }
}

// ============================================================================
// The installer service
// ============================================================================

/// Owns the managed tinymist install. Cheap to hold in `AppState`; the actual
/// work runs on a spawned task guarded by an in-progress flag so repeated
/// triggers (startup + Settings + statusbar) collapse into one download.
pub struct TinymistInstaller {
    /// Dedicated client (NOT the shared `AppState.net` one): reqwest only
    /// offers `read_timeout` on `ClientBuilder`, and a stall deadline is
    /// wrong for the other streams on the shared client (an AI-proxy LLM
    /// response can legally pause mid-thought for minutes). The install
    /// client mirrors the shared client's redirect policy and adds the
    /// stall-only read timeout.
    client: reqwest::Client,
    app: tauri::AppHandle,
    state: Mutex<InstallState>,
    /// Set once from `lib.rs` after both the installer and the LSP service
    /// exist; fires after a successful install to relaunch the LSP against
    /// the managed binary.
    on_installed: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl TinymistInstaller {
    pub fn new(app: tauri::AppHandle) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .read_timeout(READ_STALL_TIMEOUT)
            .build()
            .expect("install reqwest client build");
        Self {
            client,
            app,
            state: Mutex::new(InstallState::default()),
            on_installed: Mutex::new(None),
        }
    }

    /// Wire the post-install hook. Must be called before `begin_install` to
    /// be effective (lib.rs does so right after construction).
    pub fn set_on_installed(&self, cb: Arc<dyn Fn() + Send + Sync>) {
        *self.on_installed.lock() = Some(cb);
    }

    /// Current snapshot, probing disk for the installed version/path.
    pub fn status(&self) -> TinymistInstallStatus {
        let state = self.state.lock().clone();
        let (installed_version, installed_path) = match InstallPaths::under_home() {
            Some(p) if p.binary.is_file() => (
                Some(
                    std::fs::read_to_string(&p.version_file)
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "unknown".into()),
                ),
                Some(p.binary.to_string_lossy().into_owned()),
            ),
            _ => (None, None),
        };
        TinymistInstallStatus {
            state: state.kind(),
            in_progress: matches!(
                state.kind(),
                TinymistInstallState::Downloading | TinymistInstallState::Verifying
            ),
            target_version: TINYMIST_VERSION.into(),
            received_bytes: state.received_bytes,
            total_bytes: state.total_bytes,
            installed_version,
            installed_path,
            error: state.error,
        }
    }

    /// Start an install attempt if none is running. Returns immediately; all
    /// progress arrives via `tinymist_install` events and a follow-up
    /// `status()`. Idempotent: concurrent callers share the running attempt.
    pub fn begin_install(self: &Arc<Self>) {
        {
            let mut guard = self.state.lock();
            let kind = guard.kind();
            if matches!(
                kind,
                TinymistInstallState::Downloading | TinymistInstallState::Verifying
            ) {
                return; // already running
            }
            guard.state = Some(TinymistInstallState::Downloading);
            guard.received_bytes = 0;
            guard.total_bytes = 0;
            guard.error = None;
        }
        self.publish();

        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = this.run_install().await {
                tracing::error!("tinymist install failed: {e:#}");
                {
                    let mut guard = this.state.lock();
                    guard.state = Some(TinymistInstallState::Failed);
                    guard.error = Some(format!("{e:#}"));
                }
                this.publish();
            }
        });
    }

    /// Publish the current status as a `tinymist_install` event.
    fn publish(&self) {
        let payload = self.status();
        let _ = self.app.emit("tinymist_install", payload);
    }

    // -- the install pipeline ----------------------------------------------

    /// Full pipeline: download → verify → extract → place → smoke test →
    /// version marker. Every phase transition publishes an event. On any
    /// error the temp files are removed (and a Windows-swapped `.old` binary
    /// restored) before returning `Err`.
    async fn run_install(&self) -> anyhow::Result<()> {
        let Some(asset) = platform_asset() else {
            // Not an I/O failure — record the distinct Unsupported state.
            self.state.lock().state = Some(TinymistInstallState::Unsupported);
            self.publish();
            return Ok(());
        };
        let paths = InstallPaths::under_home()
            .ok_or_else(|| anyhow::anyhow!("cannot resolve the home directory"))?;
        std::fs::create_dir_all(&paths.dir)?;
        // Fresh attempt: drop leftovers from a previous run.
        let _ = std::fs::remove_file(&paths.download_tmp);
        let _ = std::fs::remove_file(&paths.old_binary);
        // A run killed between extraction and placement can strand a
        // full-size `*.extracted` blob; reap those too so the home dir
        // doesn't accumulate one per crash.
        remove_stale_extracts(&paths.dir);

        // 1+2. Download the archive and verify its checksum, retrying the
        // pair together: a dropped connection OR a checksum mismatch (a
        // truncated body) are both transient network outcomes, and the
        // auto-download path has no user watching to hit Retry.
        let url = asset_url(TINYMIST_VERSION, asset);
        tracing::info!("tinymist install: downloading {url}");
        let mut last_err = None;
        let mut expected_hash = None;
        for attempt in 1..=DOWNLOAD_ATTEMPTS {
            if attempt > 1 {
                let backoff = Duration::from_secs(5 * u64::from(attempt - 1));
                tracing::warn!(
                    "tinymist download attempt {attempt}/{} failed; retrying in {backoff:?}",
                    DOWNLOAD_ATTEMPTS
                );
                self.set_phase(TinymistInstallState::Downloading, |s| {
                    s.received_bytes = 0;
                });
                tokio::time::sleep(backoff).await;
            }
            match self.download_and_verify(&url, &paths.download_tmp, asset).await {
                Ok(hash) => {
                    expected_hash = Some(hash);
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        // The checksum comparison already ran inside download_and_verify; the
        // hash here is just the (verified) proof of download.
        let _ = expected_hash
            .ok_or_else(|| last_err.expect("at least one attempt ran"))?;

        // 3. Extract the tinymist binary from the archive.
        let extracted = extract_binary(&paths.download_tmp)
            .map_err(|e| anyhow::anyhow!("extract {} failed: {e}", asset))?;
        let _ = std::fs::remove_file(&paths.download_tmp);

        // 4. Move into place (the previous binary is parked as `.old` around
        // the swap on every platform). A failure must not strand the
        // multi-MB `.extracted` blob in the home dir — nothing else reaps
        // it, so repeated failures would accumulate unbounded.
        if let Err(e) = place_binary(&paths, &extracted) {
            let _ = std::fs::remove_file(&extracted);
            return Err(e);
        }
        let _ = std::fs::remove_file(&extracted);

        // 5. Smoke test before committing the version marker. On failure the
        // new binary is unverified — smoke_test removes it, and the previous
        // binary parked by the swap (if any) is restored so the managed slot
        // isn't left empty (no-op where no `.old` exists).
        let version = match self.smoke_test(&paths.binary).await {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::rename(&paths.old_binary, &paths.binary);
                return Err(e);
            }
        };
        std::fs::write(&paths.version_file, &version)?;
        // Verified: the parked previous binary is no longer needed.
        let _ = std::fs::remove_file(&paths.old_binary);

        self.state.lock().state = Some(TinymistInstallState::Installed);
        tracing::info!("tinymist {version} installed at {}", paths.binary.display());
        self.publish();

        if let Some(cb) = self.on_installed.lock().clone() {
            cb();
        }
        Ok(())
    }

    /// Set the phase (optionally adjusting progress fields) and publish.
    fn set_phase(&self, phase: TinymistInstallState, adjust: impl FnOnce(&mut InstallState)) {
        {
            let mut guard = self.state.lock();
            adjust(&mut guard);
            guard.state = Some(phase);
        }
        self.publish();
    }

    /// One attempt of the retried download+verify pair: stream the archive to
    /// `dest` and check it against the release's `sha256.sum`. Returns the
    /// verified digest. Both failure modes (connection drop, checksum
    /// mismatch from a truncated body) are transient-network outcomes the
    /// caller retries.
    async fn download_and_verify(
        &self,
        url: &str,
        dest: &Path,
        asset: &str,
    ) -> anyhow::Result<[u8; 32]> {
        let actual = self.download_with_progress(url, dest, asset).await?;
        self.set_phase(TinymistInstallState::Verifying, |s| {
            s.received_bytes = 0;
            s.total_bytes = 0;
        });
        let sums_url = asset_url(TINYMIST_VERSION, SHA_SUMS_ASSET);
        let sums = self.fetch_small(&sums_url, 1024 * 1024).await?;
        let expected = parse_sha_sums(&sums, asset)
            .ok_or_else(|| anyhow::anyhow!("'{asset}' not listed in {SHA_SUMS_ASSET}"))?;
        if expected != actual {
            anyhow::bail!(
                "checksum mismatch for '{asset}' (expected {}, got {})",
                hex_display(&expected),
                hex_display(&actual)
            );
        }
        Ok(actual)
    }

    /// GET `url`, stream the body to `dest`, emit progress events (at most
    /// ~1/second worth of chatter: every 1 MiB), and return the SHA-256 of
    /// the received bytes.
    async fn download_with_progress(
        &self,
        url: &str,
        dest: &Path,
        asset: &str,
    ) -> anyhow::Result<[u8; 32]> {
        use futures_util::StreamExt;

        // The dedicated client already carries the stall-only read timeout
        // (see TinymistInstaller::new): slow-but-alive throttled downloads
        // may take arbitrarily long; only a chunk-less connection aborts.
        let resp = self
            .client
            .get(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await?
            .error_for_status()?;
        let total = resp.content_length().unwrap_or(0);
        {
            let mut guard = self.state.lock();
            guard.total_bytes = total;
        }

        let mut file = std::io::BufWriter::new(std::fs::File::create(dest)?);
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut last_emit: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk)?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            // Emit at most once per MiB (a ~30 MB archive → ~30 events).
            if received - last_emit >= 1024 * 1024 {
                last_emit = received;
                let mut guard = self.state.lock();
                guard.received_bytes = received;
                drop(guard);
                self.publish();
            }
        }
        file.flush()?;
        drop(file);
        if total != 0 && received != total {
            anyhow::bail!("download of '{asset}' truncated: {received} of {total} bytes");
        }
        let mut guard = self.state.lock();
        guard.received_bytes = received;
        drop(guard);
        self.publish();
        Ok(hasher.finalize().into())
    }

    /// GET a small text/binary resource fully buffered (checksums file).
    async fn fetch_small(&self, url: &str, max_bytes: u64) -> anyhow::Result<String> {
        let resp = self
            .client
            .get(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(SUMS_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        let bytes = resp.bytes().await?;
        if bytes.len() as u64 > max_bytes {
            anyhow::bail!("resource at {url} unexpectedly large");
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Run `<binary> --version` and return the reported version string
    /// (e.g. `tinymist 0.15.2 (abcdef01)` — the full first line). A binary
    /// that cannot run (bad architecture, corrupted) fails here and is
    /// removed so `installed_binary()` stops reporting it.
    async fn smoke_test(&self, binary: &Path) -> anyhow::Result<String> {
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            // If the timeout below drops the output future mid-run, the
            // child is killed instead of leaking a never-verified process.
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        // Every failure mode must leave no unverified binary in the managed
        // slot — not just the bad-status one.
        let output = match tokio::time::timeout(SMOKE_TEST_TIMEOUT, cmd.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => {
                // Spawn/IO failure — the binary never verified.
                let _ = std::fs::remove_file(binary);
                anyhow::bail!("could not run the downloaded tinymist for its --version check: {e}");
            }
            Err(_) => {
                let _ = std::fs::remove_file(binary);
                anyhow::bail!(
                    "downloaded tinymist failed its --version check: no answer within {SMOKE_TEST_TIMEOUT:?}"
                );
            }
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first = stdout.lines().next().unwrap_or("").trim();
        if !output.status.success() || !first.starts_with("tinymist") {
            let _ = std::fs::remove_file(binary);
            anyhow::bail!(
                "downloaded tinymist failed its --version check (status {:?}, output {:?})",
                output.status.code(),
                first
            );
        }
        Ok(first.to_string())
    }
}

/// Move the freshly extracted binary to its final path. The previous
/// binary (if any) is parked as `.old` first — on Windows the destination
/// may be the currently-running exe, which can be RENAMED but not
/// replaced, and on Unix a plain `rename` would destroy the only copy of
/// the previously working binary before the smoke test verifies the new
/// one (`rename`-then-restore is atomic on both platforms). The parked
/// `.old` is intentionally NOT deleted here: it is the only copy of the
/// previously working binary until the smoke test verifies the new one
/// (run_install removes it after verification and restores it on a failed
/// smoke test; the next install attempt also cleans up any leftover).
fn place_binary(paths: &InstallPaths, extracted: &Path) -> anyhow::Result<()> {
    // The exec bit doesn't survive every extractor path (Unix); set it
    // before the file lands in the managed slot.
    #[cfg(unix)]
    make_executable(extracted)?;

    if paths.binary.exists() {
        std::fs::rename(&paths.binary, &paths.old_binary)?;
    }
    if let Err(e) = std::fs::rename(extracted, &paths.binary) {
        // Put the old binary back so a failed swap doesn't leave the
        // install dir empty.
        let _ = std::fs::rename(&paths.old_binary, &paths.binary);
        anyhow::bail!("placing tinymist failed: {e}");
    }
    Ok(())
}

/// chmod +x (Unix). The release archives do not always carry the exec bit
/// through every extractor path, so set it explicitly.
#[cfg(unix)]
fn make_executable(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

/// Remove leftover `*.extracted` blobs (each a full ~60-75 MB binary) from a
/// run that died between extraction and placement. Best-effort: an
/// unreadable directory or undeletable file is not an install failure.
fn remove_stale_extracts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().ends_with(".extracted") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Extract the `tinymist` binary from a downloaded release archive (zip on
/// Windows, tar.gz elsewhere) into a fresh temp file next to the archive,
/// returning its path. The archive is expected to contain exactly one entry
/// whose file name matches [`binary_name`].
fn extract_binary(archive: &Path) -> anyhow::Result<PathBuf> {
    let name = binary_name();
    let out_path = archive.with_extension("extracted");
    let mut out = std::io::BufWriter::new(std::fs::File::create(&out_path)?);
    let mut found = false;

    #[cfg(windows)]
    {
        let file = std::fs::File::open(archive)?;
        let mut zip = zip::ZipArchive::new(file)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            if entry.is_dir() {
                continue;
            }
            let entry_name = entry.name().rsplit(['/', '\\']).next().unwrap_or("");
            if entry_name != name {
                continue;
            }
            if entry.size() > MAX_BINARY_BYTES {
                anyhow::bail!("archive entry too large: {} bytes", entry.size());
            }
            std::io::copy(&mut entry, &mut out)?;
            found = true;
            break;
        }
    }
    #[cfg(not(windows))]
    {
        let file = std::fs::File::open(archive)?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut tar = tar::Archive::new(gz);
        for entry in tar.entries()? {
            let mut entry = entry?;
            let path = entry.path()?;
            let entry_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if entry_name != name {
                continue;
            }
            if entry.size() > MAX_BINARY_BYTES {
                anyhow::bail!("archive entry too large: {} bytes", entry.size());
            }
            std::io::copy(&mut entry, &mut out)?;
            found = true;
            break;
        }
    }

    out.flush()?;
    drop(out);
    if !found {
        let _ = std::fs::remove_file(&out_path);
        anyhow::bail!("no '{name}' entry found in the archive");
    }
    Ok(out_path)
}

/// Lowercase hex rendering of a digest (for error messages).
fn hex_display(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_mapping_covers_all_first_class_platforms() {
        assert_eq!(
            platform_asset_for("windows", "x86_64"),
            Some("tinymist-x86_64-pc-windows-msvc.zip")
        );
        assert_eq!(
            platform_asset_for("windows", "aarch64"),
            Some("tinymist-aarch64-pc-windows-msvc.zip")
        );
        assert_eq!(
            platform_asset_for("macos", "x86_64"),
            Some("tinymist-x86_64-apple-darwin.tar.gz")
        );
        assert_eq!(
            platform_asset_for("macos", "aarch64"),
            Some("tinymist-aarch64-apple-darwin.tar.gz")
        );
        assert_eq!(
            platform_asset_for("linux", "x86_64"),
            Some("tinymist-x86_64-unknown-linux-gnu.tar.gz")
        );
        assert_eq!(
            platform_asset_for("linux", "aarch64"),
            Some("tinymist-aarch64-unknown-linux-gnu.tar.gz")
        );
        assert_eq!(
            platform_asset_for("linux", "arm"),
            Some("tinymist-arm-unknown-linux-gnueabihf.tar.gz")
        );
    }

    #[test]
    fn asset_mapping_rejects_unknown_platforms() {
        assert_eq!(platform_asset_for("freebsd", "x86_64"), None);
        assert_eq!(platform_asset_for("linux", "riscv64"), None);
        assert_eq!(platform_asset_for("linux", "loongarch64"), None);
    }

    #[test]
    fn download_url_shape() {
        assert_eq!(
            asset_url("0.15.2", "tinymist-x86_64-pc-windows-msvc.zip"),
            "https://github.com/Myriad-Dreamin/tinymist/releases/download/v0.15.2/tinymist-x86_64-pc-windows-msvc.zip"
        );
    }

    const SUMS: &str = "\
16241868c6752aa5e8f9c162562293c7cdf69e82f54687d7886336daf2c51915 *tinymist-aarch64-apple-darwin.tar.gz\n\
91edb0d21edca5841b896d702d8086622792d52b71a9b444d8befb0e937969ae *tinymist-x86_64-pc-windows-msvc.zip\n\
9b8a1aea6bb3fc9c39cb70496f0082bd518cfede555757bc3cb5225b05abc99b  tinymist-x86_64-unknown-linux-gnu.tar.gz\n";

    #[test]
    fn parse_sha_sums_handles_binary_and_text_separators() {
        // Binary-mode `*` separator (what the release actually ships).
        let got = parse_sha_sums(SUMS, "tinymist-x86_64-pc-windows-msvc.zip").unwrap();
        assert_eq!(
            hex_display(&got),
            "91edb0d21edca5841b896d702d8086622792d52b71a9b444d8befb0e937969ae"
        );
        // Text-mode two-space separator.
        let got = parse_sha_sums(SUMS, "tinymist-x86_64-unknown-linux-gnu.tar.gz").unwrap();
        assert_eq!(
            hex_display(&got),
            "9b8a1aea6bb3fc9c39cb70496f0082bd518cfede555757bc3cb5225b05abc99b"
        );
        // Unknown asset → None.
        assert!(parse_sha_sums(SUMS, "tinymist-win32-x64.exe").is_none());
        assert!(parse_sha_sums("", "anything").is_none());
    }

    #[test]
    fn parse_sha_sums_ignores_malformed_lines() {
        let sums = "garbage line\n\
                    \n\
            16241868c6752aa5e8f9c162562293c7cdf69e82f54687d7886336daf2c51915 *tinymist-aarch64-apple-darwin.tar.gz\n";
        assert!(
            parse_sha_sums(sums, "tinymist-aarch64-apple-darwin.tar.gz").is_some(),
            "malformed sibling lines must not break the scan"
        );
    }

    /// A line whose byte 64 falls inside a multi-byte char (reachable: the
    /// body goes through `String::from_utf8_lossy`, which turns invalid bytes
    /// into 3-byte U+FFFD) must be skipped, not panic on the split.
    #[test]
    fn parse_sha_sums_skips_multibyte_char_straddling_the_split() {
        // 63 hex bytes + 'é' (2 bytes spanning offsets 63..65) + padding:
        // 69 bytes total (>= 66), and byte 64 is mid-char.
        let bad = format!("{}éabcd", "a".repeat(63));
        assert!(bad.len() >= 66);
        assert_eq!(bad.chars().count(), 68);
        let sums = format!(
            "{bad}\n91edb0d21edca5841b896d702d8086622792d52b71a9b444d8befb0e937969ae *tinymist-x86_64-pc-windows-msvc.zip\n"
        );
        assert!(
            parse_sha_sums(&sums, "tinymist-x86_64-pc-windows-msvc.zip").is_some(),
            "the straddling line is skipped; the valid line after it still parses"
        );
        // And when ONLY the straddling line names the asset: no match, no panic.
        assert!(parse_sha_sums(&bad, "abcd").is_none());
    }

    #[test]
    fn hex_to_32_roundtrip() {
        // 8 chars + 56 chars = the required 64.
        let hex = format!("00ff10ee{}", "1".repeat(56));
        assert_eq!(hex_to_32(&hex).unwrap()[0], 0x00);
        assert_eq!(hex_to_32(&hex).unwrap()[1], 0xff);
        assert_eq!(hex_to_32(&hex).unwrap()[2], 0x10);
        assert_eq!(hex_to_32(&hex).unwrap()[3], 0xee);
        assert!(hex_to_32("zz").is_none());
        assert!(hex_to_32(&"0".repeat(63)).is_none());
    }

    #[test]
    fn resolve_order_is_custom_then_managed_then_path() {
        // The custom override always wins when non-empty (whitespace-only
        // counts as empty).
        assert_eq!(
            resolve_tinymist_path("C:/tools/tinymist.exe"),
            "C:/tools/tinymist.exe"
        );
        assert_eq!(resolve_tinymist_path("  "), "tinymist");
        // On a machine without a managed install the PATH fallback is
        // "tinymist"; with one, the managed path. The managed case is
        // environment-dependent, so only assert the no-install branch when
        // the dir is absent.
        if installed_binary().is_none() {
            assert_eq!(resolve_tinymist_path(""), "tinymist");
        } else {
            assert!(resolve_tinymist_path("").ends_with(binary_name()));
        }
    }

    /// Build a release-shaped archive (a decoy entry + the tinymist binary,
    /// in a `bin/` subdirectory like cargo-dist sometimes uses) and assert
    /// `extract_binary` picks exactly the right entry by file name.
    #[test]
    fn extract_binary_finds_tinymist_in_archive() {
        let dir = std::env::temp_dir().join(format!(
            "typst-tinymist-extract-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let archive_path = dir.join(if cfg!(windows) { "a.zip" } else { "a.tar.gz" });
        let binary_contents = b"#!/bin/sh\necho tinymist 0.15.2 fake\n";

        #[cfg(windows)]
        {
            use std::io::Write as _;
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
            zip.start_file("README.md", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"readme").unwrap();
            zip.start_file(
                format!("bin/{}", binary_name()),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(binary_contents).unwrap();
            zip.finish().unwrap();
        }
        #[cfg(not(windows))]
        {
            let gz = flate2::write::GzEncoder::new(
                std::fs::File::create(&archive_path).unwrap(),
                flate2::Compression::default(),
            );
            let mut tar = tar::Builder::new(gz);
            tar.append_data(&mut tar::Header::new_gnu(), "README.md", b"readme" as &[u8])
                .unwrap();
            tar.append_data(
                &mut tar::Header::new_gnu(),
                format!("bin/{}", binary_name()),
                binary_contents as &[u8],
            )
            .unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }

        let extracted = extract_binary(&archive_path).expect("extraction succeeds");
        let got = std::fs::read(&extracted).unwrap();
        assert_eq!(got, binary_contents);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An archive without a tinymist entry is an error (and leaves no
    /// extracted file behind).
    #[test]
    fn extract_binary_rejects_archive_without_tinymist() {
        let dir = std::env::temp_dir().join(format!(
            "typst-tinymist-extract-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let archive_path = dir.join(if cfg!(windows) { "a.zip" } else { "a.tar.gz" });

        #[cfg(windows)]
        {
            use std::io::Write as _;
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
            zip.start_file("README.md", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"readme").unwrap();
            zip.finish().unwrap();
        }
        #[cfg(not(windows))]
        {
            let gz = flate2::write::GzEncoder::new(
                std::fs::File::create(&archive_path).unwrap(),
                flate2::Compression::default(),
            );
            let mut tar = tar::Builder::new(gz);
            tar.append_data(&mut tar::Header::new_gnu(), "README.md", b"readme" as &[u8])
                .unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }

        assert!(extract_binary(&archive_path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hand-built `InstallPaths` inside a throwaway temp dir.
    fn test_paths(dir: &Path) -> InstallPaths {
        InstallPaths {
            dir: dir.to_path_buf(),
            binary: dir.join(binary_name()),
            version_file: dir.join("tinymist.version"),
            download_tmp: dir.join("dl.download"),
            old_binary: dir.join("dl.old"),
        }
    }

    /// A successful swap parks the previous binary as `.old` (on every
    /// platform — on Unix a plain rename would destroy it before the smoke
    /// test clears the new binary, leaving the managed slot unrecoverable).
    #[test]
    fn place_binary_parks_previous_as_old() {
        let dir = std::env::temp_dir().join(format!(
            "typst-tinymist-place-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = test_paths(&dir);
        std::fs::write(&paths.binary, b"previous").unwrap();
        let extracted = dir.join("fresh.extracted");
        std::fs::write(&extracted, b"fresh").unwrap();

        place_binary(&paths, &extracted).expect("swap succeeds");
        assert_eq!(std::fs::read(&paths.binary).unwrap(), b"fresh");
        assert_eq!(
            std::fs::read(&paths.old_binary).unwrap(),
            b"previous",
            "the previous binary must be parked, not destroyed"
        );
        assert!(!extracted.exists(), "moved, not copied");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A failed swap (the extracted file vanished) restores the previous
    /// binary instead of leaving the managed slot empty.
    #[test]
    fn place_binary_restores_previous_when_swap_fails() {
        let dir = std::env::temp_dir().join(format!(
            "typst-tinymist-place-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = test_paths(&dir);
        std::fs::write(&paths.binary, b"current").unwrap();

        let err = place_binary(&paths, &dir.join("missing"));
        assert!(err.is_err(), "swapping in a missing file must fail");
        assert_eq!(
            std::fs::read(&paths.binary).unwrap(),
            b"current",
            "the previous binary must be back in the managed slot"
        );
        assert!(
            !paths.old_binary.exists(),
            "the parked copy is consumed by the restore"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fresh-attempt sweep reaps stranded `*.extracted` blobs and touches
    /// nothing else in the install dir.
    #[test]
    fn remove_stale_extracts_only_touches_extract_blobs() {
        let dir = std::env::temp_dir().join(format!(
            "typst-tinymist-sweep-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tinymist.extracted"), b"stale").unwrap();
        std::fs::write(dir.join("other.extracted"), b"stale").unwrap();
        std::fs::write(dir.join(binary_name()), b"live").unwrap();
        std::fs::write(dir.join("tinymist.version"), b"0.15.2").unwrap();
        std::fs::write(dir.join("tinymist.download"), b"partial").unwrap();

        remove_stale_extracts(&dir);
        assert!(!dir.join("tinymist.extracted").exists());
        assert!(!dir.join("other.extracted").exists());
        assert!(dir.join(binary_name()).is_file());
        assert!(dir.join("tinymist.version").is_file());
        assert!(dir.join("tinymist.download").is_file());
        // A missing dir is a no-op, not a panic.
        remove_stale_extracts(&dir.join("nope"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REAL-network end-to-end of the install pipeline (everything except the
    /// AppHandle event emission and the final placement into ~/.typststudio/):
    /// stream the actual release archive, hash it, verify against the actual
    /// sha256.sum, extract the real binary, and run its `--version`.
    ///
    /// `#[ignore]`d: it downloads ~30 MB from GitHub on every run, so it is
    /// opt-in (`cargo test --lib -- --ignored`) rather than part of the normal
    /// suite.
    #[tokio::test]
    #[ignore = "downloads ~30 MB from GitHub; run explicitly with --ignored"]
    async fn real_release_pipeline_downloads_verifies_extracts_and_runs() {
        use futures_util::StreamExt;

        let Some(asset) = platform_asset() else {
            // Not a failure — the host platform just has no release asset.
            eprintln!("skipping: no release asset for this platform");
            return;
        };
        let dir = std::env::temp_dir()
            .join(format!("typst-tinymist-e2e-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("archive");

        // 1. Stream the real archive, hashing as we go (mirrors
        //    download_with_progress without the progress state). Same client
        //    shape as the installer's: redirect-following + stall-only
        //    read timeout.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .read_timeout(READ_STALL_TIMEOUT)
            .build()
            .expect("test reqwest client build");
        let resp = client
            .get(asset_url(TINYMIST_VERSION, asset))
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .expect("release download request")
            .error_for_status()
            .expect("release download status");
        let total = resp.content_length().expect("Content-Length present");
        let mut file = std::io::BufWriter::new(std::fs::File::create(&archive).unwrap());
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.expect("chunk");
            file.write_all(&chunk).unwrap();
            hasher.update(&chunk);
            received += chunk.len() as u64;
        }
        file.flush().unwrap();
        drop(file);
        assert_eq!(received, total, "downloaded size matches Content-Length");
        let actual_hash: [u8; 32] = hasher.finalize().into();

        // 2. Verify against the real sha256.sum.
        let sums = client
            .get(asset_url(TINYMIST_VERSION, SHA_SUMS_ASSET))
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(SUMS_TIMEOUT)
            .send()
            .await
            .expect("sha256.sum request")
            .error_for_status()
            .expect("sha256.sum status")
            .text()
            .await
            .expect("sha256.sum body");
        let expected = parse_sha_sums(&sums, asset).expect("asset listed in sha256.sum");
        assert_eq!(expected, actual_hash, "checksum matches the release");

        // 3. Extract the real binary (plus the exec bit on Unix, like
        //    place_binary).
        let extracted = extract_binary(&archive).expect("extract the real binary");
        #[cfg(unix)]
        make_executable(&extracted).unwrap();

        // 4. Smoke test the real binary (mirrors TinymistInstaller::smoke_test).
        let mut cmd = tokio::process::Command::new(&extracted);
        cmd.arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = tokio::time::timeout(SMOKE_TEST_TIMEOUT, cmd.output())
            .await
            .expect("smoke test within timeout")
            .expect("smoke test spawn");
        let first = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        assert!(output.status.success(), "exit ok");
        assert!(
            first.starts_with("tinymist"),
            "version output starts with 'tinymist', got: {first:?}"
        );
        eprintln!("smoke test output: {first}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
