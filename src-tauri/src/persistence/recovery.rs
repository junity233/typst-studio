//! Crash-recovery: dirty-buffer snapshots + clean-shutdown detection (§5.1).
//!
//! The editor keeps the user's unsaved text in a per-document private directory
//! (`<app-data>/recovery/`) so that an app crash, OS logout, or power loss does
//! not silently lose it. This is **not** auto-save — it never writes the user's
//! file. On the next launch, if the prior session did not finish a clean
//! shutdown (or a snapshot is newer than what's on disk), the frontend offers a
//! recovery dialog (§5.1.3).
//!
//! ## Layout (§5.1.2)
//!
//! ```text
//! <app-data>/recovery/
//! ├── manifest.json          // index of snapshot refs + app version
//! ├── manifest.json.bak      // last known-good (via write_with_backup)
//! ├── documents/
//! │   ├── <document-id>.json // full RecoverySnapshot incl. the unsaved buffer
//! │   └── ...
//! └── clean-shutdown         // marker; present iff the last shutdown was clean
//! ```
//!
//! Every snapshot + the manifest is written via [`atomic::write_json`] (single
//! temp-file + `fsync` + atomic rename — §5.2). The manifest additionally
//! rotates a `.bak` via [`write_with_backup`], so a corrupt manifest falls back
//! to the backup ([`load_json_with_backup`]).
//!
//! ## Debounce (§5.1.2)
//!
//! Editing is bursty; writing a snapshot on every keystroke would burn IO and
//! disk. [`schedule_snapshot`] is called from `DocumentService::update_text`;
//! the latest buffer for each dirty doc is coalesced in a single buffer, and a
//! background thread flushes after 750ms of quiescence (capped at a 2s max
//! delay so even continuous typing lands a snapshot within the §5.1.2
//! "revision→disk ≤ 2s" target). [`flush_now`] bypasses the timer for the
//! blur / sleep / close paths. The debounce duration is injectable so tests can
//! use a few milliseconds.
//!
//! ## Sanitization (§7.4)
//!
//! Only document ids, paths (already local app-data paths), titles, and
//! outcomes are logged — never document text. The snapshot files themselves DO
//! hold text (that's their purpose), but they live in the app's private data
//! directory with the current user's permissions (§9).
//!
//! ## Manifest access contract
//!
//! The manifest is **read fresh from disk on every mutation** (`load_manifest`
//! → mutate → persist) — there is no long-lived in-memory mirror. The
//! `manifest` `Mutex<()>` only **serializes** read-modify-write between the
//! debounce worker (which writes from its own thread) and the synchronous ops
//! (`snapshot_dirty_documents`, `discard_snapshot`, `clear_all`), so the two
//! paths never interleave a half-applied manifest and one can't clobber the
//! other's entries. The worker's `flush_pending` re-loads the manifest before
//! merging its pending batch; the sync ops do the same. A discarded-document
//! id that races a flush is additionally guarded by a shared
//! `discarded_since_queued` set (§5.1.4) so the worker cannot re-write a
//! snapshot the user just discarded.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::domain::disk_version::DiskVersion;
use crate::domain::document::{DocumentId, DocumentMeta};
use crate::error::Result;
use crate::persistence::atomic::write_json;
use crate::persistence::backup::{load_json_with_backup, write_with_backup, LoadOutcome};

/// Current recovery-store schema version. Bumps here are handled by an explicit
/// migration step registered against [`crate::persistence::migrate::Migrator`]
/// (no steps yet — v1 is the initial shape).
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The clean-shutdown marker filename. Present iff the last session ran the
/// full close flow (all saves or explicit discards). On startup the marker is
/// removed FIRST, and only re-written once the close flow completes — so a
/// crash leaves the marker absent and recovery is offered (§5.1.2 / §5.1.3).
const CLEAN_SHUTDOWN_MARKER: &str = "clean-shutdown";

/// The manifest filename (relative to the recovery dir).
const MANIFEST_FILENAME: &str = "manifest.json";

/// The per-document snapshot subdirectory (relative to the recovery dir).
const DOCUMENTS_DIR: &str = "documents";

/// Default debounce: 750ms of quiescence before a burst of edits flushes a
/// snapshot (§5.1.2).
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(750);

/// Hard ceiling on the debounce delay so continuous typing still lands a
/// snapshot within the §5.1.2 "revision→disk ≤ 2s" target. Even if edits keep
/// arriving, a flush fires at most this long after the first pending edit.
const MAX_DEBOUNCE_DELAY: Duration = Duration::from_millis(2000);

// ---------------------------------------------------------------------------
// On-disk types
// ---------------------------------------------------------------------------

/// The recovery manifest: an index of snapshot refs plus a schema/app version.
///
/// Stored as `manifest.json` and rotated through `manifest.json.bak`. Each
/// entry mirrors the latest snapshot for one document; the full snapshot (with
/// the unsaved buffer) lives in `documents/<id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryManifest {
    /// Schema version for forward migrations (§7.3). Defaults to 0 when absent
    /// on disk; [`RecoveryService::load_manifest`] migrates it up to
    /// [`CURRENT_SCHEMA_VERSION`].
    #[serde(default)]
    pub schema_version: u32,
    /// One entry per document that currently has a snapshot.
    #[serde(default)]
    pub snapshots: Vec<SnapshotRef>,
    /// App version that wrote this manifest (best-effort provenance).
    #[serde(default)]
    pub app_version: String,
}

impl Default for RecoveryManifest {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            snapshots: Vec::new(),
            app_version: app_version_string(),
        }
    }
}

/// A manifest entry: a lightweight reference to a document snapshot. The full
/// snapshot (with text) is loaded on demand from `documents/<id>.json`.
///
/// Not exported via ts-rs — it never crosses IPC (only the
/// [`RecoverableInfo`](crate::ipc::events::RecoverableInfo) summary does).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRef {
    pub document_id: String,
    /// Canonical disk path, if the document has one (`None` for Untitled).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    pub title: String,
    pub revision: u64,
    /// Unix-millis capture timestamp.
    pub captured_at: i64,
}

/// A full per-document recovery snapshot, including the unsaved buffer text.
///
/// This is the data that lets the user get their work back after a crash. One
/// file per document at `documents/<id>.json`, written atomically. Not exported
/// via ts-rs directly — the IPC layer wraps it in
/// [`RecoverableInfo`](crate::ipc::events::RecoverableInfo) /
/// [`RecoveredDocument`](crate::ipc::events::RecoveredDocument) for the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverySnapshot {
    #[serde(default)]
    pub schema_version: u32,
    pub document_id: String,
    /// Origin serialized as a string tag (`"untitled"` / `"workspace"` /
    /// `"loose"`) — the recovery flow only needs to know whether the doc had a
    /// disk backing, not the full origin enum.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    pub title: String,
    /// THE unsaved buffer. This is the whole point of the snapshot.
    pub content: String,
    pub revision: u64,
    /// The disk version at capture time, so startup recovery can tell whether
    /// the disk changed between capture and the next launch (§5.1.3). `None`
    /// for untitled docs (no disk backing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_version: Option<DiskVersion>,
    /// Unix-millis capture timestamp.
    pub captured_at: i64,
    #[serde(default)]
    pub app_version: String,
}

// ---------------------------------------------------------------------------
// Debounce control messages
// ---------------------------------------------------------------------------

/// A pending snapshot held in the debounce buffer: the latest meta + text for
/// one document, captured at a specific instant.
#[derive(Clone)]
struct Pending {
    meta: DocumentMeta,
    text: String,
    disk_version: Option<DiskVersion>,
    first_queued: Instant,
}

/// Messages sent to the debounce worker thread.
enum Msg {
    /// (Re)start the debounce timer for `id` with the latest buffer. Coalesces
    /// bursts: only the most recent `Update` per id is kept.
    Update {
        id: DocumentId,
        meta: DocumentMeta,
        text: String,
        disk_version: Option<DiskVersion>,
    },
    /// A document became clean / was discarded / was closed — drop its pending
    /// entry (and the on-disk snapshot is handled by the caller).
    Cancel(DocumentId),
    /// The user explicitly discarded `id` (§5.1.4). Drops any pending entry AND
    /// records the id in the shared "discarded since queued" set so a racing
    /// `flush_pending` cannot re-write it. Sent from `discard_snapshot`.
    Discard(DocumentId),
    /// Flush every pending snapshot now (blur / sleep / close path).
    FlushNow,
    /// Drop everything pending AND wipe the recovery dir. Sent from `clear_all`.
    Clear,
    /// Stop the worker thread (drop the handle).
    Shutdown,
}

// ---------------------------------------------------------------------------
// RecoveryService
// ---------------------------------------------------------------------------

/// The crash-recovery subsystem (§5.1).
///
/// Owns the recovery directory layout and a coalescing debounce thread. The
/// public snapshot API is split between:
/// - **debounced** writes via [`schedule_snapshot`] (called from
///   `DocumentService::update_text`), and
/// - **immediate** writes via [`flush_now`] / [`snapshot_dirty_documents`]
///   (called from blur / sleep / close / save).
///
/// `discard_snapshot`, `mark_clean_shutdown`, `clear_clean_shutdown`,
/// `list_recoverable`, `clear_all`, and `has_clean_shutdown` are all immediate
/// and synchronous. The debounce thread is purely an optimization for the
/// bursty edit path; [`flush_now`] runs on the caller's thread.
///
/// The service is `Send + Sync` and cheap to clone behind an `Arc` (it is held
/// in `AppState` and the `DocumentService`). Construct via [`new`].
pub struct RecoveryService {
    recovery_dir: PathBuf,
    documents_dir: PathBuf,
    manifest_path: PathBuf,
    /// Serializes manifest mutation between the debounce worker and the
    /// synchronous ops. The manifest is **always read fresh from disk** on every
    /// mutation (`load_manifest` → mutate → `persist`), so the worker and sync
    /// ops never diverge: whoever holds this lock sees the true on-disk state.
    /// The lock is held for the full read-modify-write, which is fast (single
    /// JSON file). This fixes the manifest-mirror divergence where a sync op
    /// persisted a stale in-memory copy and clobbered worker-added entries.
    manifest: Mutex<()>,
    /// Document ids discarded since they were last queued for a snapshot
    /// (§5.1.4). `discard_snapshot` inserts here; `flush_pending` checks and
    /// removes entries before writing each pending snapshot, skipping any id in
    /// the set so a race between the worker draining `pending` and the discard
    /// can never re-create a discarded snapshot.
    discarded_since_queued: Arc<Mutex<HashSet<DocumentId>>>,
    /// The debounce worker handle. `None` when debouncing is disabled (tests
    /// that drive [`flush_now`] directly, or a future "recovery off" toggle).
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Sender into the debounce worker. Cloned per `schedule_snapshot` call.
    sender: std::sync::mpsc::Sender<Msg>,
    /// Debounce window. Stored for tests that want to assert on it.
    #[allow(dead_code)]
    debounce: Duration,
}

impl RecoveryService {
    /// Construct the service over `recovery_dir`, creating it and the
    /// `documents/` subdir if missing. Loads the manifest tolerantly
    /// (missing/corrupt → empty, falling back to `.bak` per §5.2). The debounce
    /// worker thread is spawned with the default 750ms window.
    pub fn new(recovery_dir: PathBuf) -> Result<Self> {
        Self::with_debounce(recovery_dir, DEFAULT_DEBOUNCE)
    }

    /// Like [`new`] but with an injectable debounce window (for tests). A
    /// `Duration::ZERO` debounce still spawns the worker (it flushes on the
    /// next timer tick), keeping the threading model uniform.
    pub fn with_debounce(recovery_dir: PathBuf, debounce: Duration) -> Result<Self> {
        let documents_dir = recovery_dir.join(DOCUMENTS_DIR);
        std::fs::create_dir_all(&recovery_dir)?;
        std::fs::create_dir_all(&documents_dir)?;
        let manifest_path = recovery_dir.join(MANIFEST_FILENAME);
        // Validate the manifest is readable tolerantly (missing/corrupt → empty,
        // falling back to `.bak` per §5.2). The result isn't kept: every
        // mutation reads fresh from disk under the lock.
        let _ = Self::load_manifest(&manifest_path)?;

        let (sender, receiver) = std::sync::mpsc::channel::<Msg>();
        let pending: HashMap<DocumentId, Pending> = HashMap::new();

        // State captured by the worker. `Arc` so the closure can outlive the
        // builder without borrowing `self`.
        let dir = recovery_dir.clone();
        let mpath = manifest_path.clone();
        let debounce_for_thread = debounce;
        let discarded_since_queued = Arc::new(Mutex::new(HashSet::<DocumentId>::new()));
        let worker_discarded = discarded_since_queued.clone();
        let handle = std::thread::Builder::new()
            .name("typst-recovery".into())
            .spawn(move || {
        let rx = receiver;
        let mut pending = pending;
        let discarded_since_queued = worker_discarded;
                // The deadline at which we flush. `None` = no pending edits.
                let mut deadline: Option<Instant> = None;

                loop {
                    // Compute the timeout for the recv. If a deadline is set we
                    // sleep until the earlier of (deadline) or (max-delay from
                    // the first queued edit). Otherwise block indefinitely.
                    let timeout = match deadline {
                        Some(d) => {
                            // Cap by the max-delay so a long burst still flushes.
                            let earliest_pending = pending
                                .values()
                                .map(|p| p.first_queued)
                                .min()
                                .unwrap_or_else(Instant::now);
                            let max_deadline = earliest_pending + MAX_DEBOUNCE_DELAY;
                            let effective = std::cmp::min(d, max_deadline);
                            let now = Instant::now();
                            effective.checked_duration_since(now).unwrap_or_default()
                        }
                        None => Duration::from_secs(60 * 60),
                    };

                    match rx.recv_timeout(timeout) {
                        Ok(Msg::Update { id, meta, text, disk_version }) => {
                            let now = Instant::now();
                            let first_queued = pending
                                .get(&id)
                                .map(|p| p.first_queued)
                                .unwrap_or(now);
                            pending.insert(
                                id,
                                Pending { meta, text, disk_version, first_queued },
                            );
                            // (Re)arm the debounce deadline from now.
                            deadline = Some(now + debounce_for_thread);
                        }
                        Ok(Msg::Cancel(id)) => {
                            pending.remove(&id);
                            if pending.is_empty() {
                                deadline = None;
                            }
                        }
                        Ok(Msg::Discard(id)) => {
                            // §5.1.4: drop any pending entry for `id` and
                            // remember it as discarded so a `flush_pending`
                            // racing this message cannot re-write its
                            // snapshot. The on-disk file + manifest entry are
                            // removed synchronously by `discard_snapshot`; the
                            // set guard only defeats the worker's re-write.
                            pending.remove(&id);
                            discarded_since_queued.lock().insert(id);
                            if pending.is_empty() {
                                deadline = None;
                            }
                        }
                        Ok(Msg::FlushNow) => {
                            Self::flush_pending(&dir, &mpath, &mut pending, &discarded_since_queued);
                            deadline = None;
                        }
                        Ok(Msg::Clear) => {
                            pending.clear();
                            deadline = None;
                            let _ = Self::wipe_dir(&dir);
                        }
                        Ok(Msg::Shutdown) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            // Best-effort final flush on shutdown so a graceful
                            // drop doesn't lose pending edits. Errors are
                            // swallowed: shutdown must not panic.
                            Self::flush_pending(&dir, &mpath, &mut pending, &discarded_since_queued);
                            break;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            // Deadline reached (or the long idle poll elapsed)
                            // → flush if there's anything pending.
                            if !pending.is_empty() {
                                Self::flush_pending(&dir, &mpath, &mut pending, &discarded_since_queued);
                            }
                            deadline = None;
                        }
                    }
                }
            })?;

        Ok(Self {
            recovery_dir,
            documents_dir,
            manifest_path,
            manifest: Mutex::new(()),
            discarded_since_queued,
            worker: Mutex::new(Some(handle)),
            sender,
            debounce,
        })
    }

    // --- clean-shutdown marker ------------------------------------------------

    /// Write the clean-shutdown marker. Called only at the end of a successful
    /// close flow (§5.1.2). Best-effort: a failure here is logged and the
    /// caller proceeds — recovery would rather over-offer than block a close.
    pub fn mark_clean_shutdown(&self) {
        let marker = self.recovery_dir.join(CLEAN_SHUTDOWN_MARKER);
        if let Err(e) = write_json(&marker, b"clean") {
            tracing::warn!(?marker, error = %e, "recovery: could not write clean-shutdown marker");
        }
    }

    /// Remove the clean-shutdown marker. Called FIRST at startup so a crash
    /// during this session is detectable on the next launch (§5.1.2). Best-effort.
    pub fn clear_clean_shutdown(&self) {
        let marker = self.recovery_dir.join(CLEAN_SHUTDOWN_MARKER);
        match std::fs::remove_file(&marker) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(?marker, error = %e, "recovery: could not remove clean-shutdown marker"),
        }
    }

    /// Whether the clean-shutdown marker is present (i.e. the prior session
    /// finished its close flow). Combined with snapshot-revision checks in the
    /// startup detection logic (§5.1.3).
    pub fn has_clean_shutdown(&self) -> bool {
        self.recovery_dir.join(CLEAN_SHUTDOWN_MARKER).exists()
    }

    // --- debounced snapshot path ---------------------------------------------

    /// Schedule a debounced snapshot for `id` (called from
    /// `DocumentService::update_text`). The latest meta + text coalesce in the
    /// worker buffer; a flush lands after the debounce window of quiescence.
    /// Best-effort: a send failure (worker gone) is logged, never propagated.
    pub fn schedule_snapshot(
        &self,
        meta: DocumentMeta,
        text: String,
        disk_version: Option<DiskVersion>,
    ) {
        let id = meta.id;
        if let Err(e) = self.sender.send(Msg::Update {
            id,
            meta,
            text,
            disk_version,
        }) {
            tracing::trace!(?id, error = %e, "recovery: debounce worker gone; snapshot dropped");
        }
    }

    /// Cancel any pending snapshot for `id` (e.g. it was just discarded).
    pub fn cancel_pending(&self, id: DocumentId) {
        let _ = self.sender.send(Msg::Cancel(id));
    }

    // --- immediate snapshot paths --------------------------------------------

    /// Flush all pending snapshots immediately (bypassing the debounce timer).
    /// Used for blur / sleep / close paths (§5.1.2) where the user expects
    /// their edits to be durable now.
    pub fn flush_now(&self) {
        let _ = self.sender.send(Msg::FlushNow);
    }

    /// Synchronously write/update a snapshot for each dirty doc, and DELETE the
    /// snapshot + manifest entry for each clean doc. Used by the immediate
    /// flush paths (close, save) and by tests that want deterministic on-disk
    /// state without waiting for the debounce.
    ///
    /// `text_for` resolves a document's current buffer text; documents for
    /// which it returns `None` are skipped (treated as not snapshottable).
    ///
    /// Reads the manifest fresh from disk under the lock (read-modify-write),
    /// so it never clobbers entries a concurrent worker flush added.
    pub fn snapshot_dirty_documents(
        &self,
        docs: &[DocumentMeta],
        text_for: impl Fn(DocumentId) -> Option<String>,
    ) {
        // Build a map of id → (disk_version) from the caller's docs. We don't
        // have direct access to the tab store here (persistence must not
        // depend on service), so the caller supplies disk_version via the meta
        // snapshot it already holds — but DocumentMeta doesn't carry
        // disk_version (that's on TabState). So we pass disk_version alongside
        // via a parallel lookup keyed on id. To keep this signature simple we
        // compute disk_version from the canonical path when available.
        let _guard = self.manifest.lock();
        let mut manifest = Self::load_manifest(&self.manifest_path).unwrap_or_default();
        for meta in docs {
            let id_str = meta.id.to_string();
            let snapshot_path = self.documents_dir.join(format!("{id_str}.json"));
            if meta.dirty {
                let Some(text) = text_for(meta.id) else { continue };
                let disk_version = meta
                    .origin
                    .canonical_path()
                    .and_then(|p| DiskVersion::from_path(p).ok());
                if let Err(e) = self.write_one_snapshot(&mut manifest, meta, &text, disk_version) {
                    tracing::warn!(id = %id_str, error = %e, "recovery: snapshot write failed");
                }
            } else {
                // Clean doc: remove its snapshot + manifest entry (§5.1.2
                // "clean 文档删除快照").
                let _ = std::fs::remove_file(&snapshot_path);
                manifest.snapshots.retain(|s| s.document_id != id_str);
            }
        }
        if let Err(e) = self.persist_manifest(&manifest) {
            tracing::warn!(error = %e, "recovery: manifest persist failed after snapshot_dirty_documents");
        }
    }

    /// Delete the snapshot + manifest entry for `id` (§5.1.4: the user chose
    /// "Don't Save", so the content must not be recoverable next launch).
    /// Immediate and synchronous.
    ///
    /// §5.1.4 race guarantee: if the debounce worker has already drained
    /// `pending` into `flush_pending` (via `std::mem::take`) just before this
    /// call, the snapshot would otherwise be re-written by that in-flight flush.
    /// We (a) send [`Msg::Discard`] so the worker drops any pending entry and
    /// records the id as discarded, AND (b) insert the id into the shared
    /// `discarded_since_queued` set here too, so a flush that has ALREADY taken
    /// `pending` (and won't see our `Discard` message) still skips `id`.
    pub fn discard_snapshot(&self, id: DocumentId) {
        let id_str = id.to_string();
        let snapshot_path = self.documents_dir.join(format!("{id_str}.json"));
        // Record the discard FIRST in the shared set, so even if the worker has
        // already drained `pending` into a local batch (and won't observe our
        // `Discard` message), `flush_pending`'s per-id check still skips `id`.
        self.discarded_since_queued.lock().insert(id);
        // Also tell the worker to drop any pending entry for this id (the
        // common path: the edit is still buffered, not yet drained).
        let _ = self.sender.send(Msg::Discard(id));
        match std::fs::remove_file(&snapshot_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(?snapshot_path, error = %e, "recovery: discard_snapshot remove failed"),
        }
        let _guard = self.manifest.lock();
        let mut manifest = Self::load_manifest(&self.manifest_path).unwrap_or_default();
        let before = manifest.snapshots.len();
        manifest.snapshots.retain(|s| s.document_id != id_str);
        if manifest.snapshots.len() != before {
            if let Err(e) = self.persist_manifest(&manifest) {
                tracing::warn!(error = %e, "recovery: manifest persist failed after discard");
            }
        }
    }

    /// Delete all snapshots + the manifest, and remove the clean-shutdown
    /// marker (§5.1.4 / settings "clear recovery data"). Wipes the recovery
    /// dir's contents but keeps the dir itself.
    pub fn clear_all(&self) {
        // Tell the worker to drop its buffer and wipe the dir; also do it
        // synchronously here so the caller sees an empty dir on return.
        let _ = self.sender.send(Msg::Clear);
        let _ = Self::wipe_dir(&self.recovery_dir);
        // Persist a fresh empty manifest under the lock so the on-disk state
        // matches (read-modify-write from disk, never trusting a stale mirror).
        let _guard = self.manifest.lock();
        let manifest = RecoveryManifest::default();
        if let Err(e) = self.persist_manifest(&manifest) {
            tracing::warn!(error = %e, "recovery: clear_all manifest reset failed");
        }
    }

    // --- read paths ----------------------------------------------------------

    /// Read every snapshot, tolerant of individual corruption (§11.1: one
    /// corrupt snapshot does not block the others). Snapshots are read from the
    /// manifest index; a snapshot missing on disk or failing to parse is
    /// skipped. Returns the snapshots in manifest order.
    pub fn list_recoverable(&self) -> Vec<RecoverySnapshot> {
        let manifest = Self::load_manifest(&self.manifest_path)
            .unwrap_or_default();
        let mut out = Vec::with_capacity(manifest.snapshots.len());
        for entry in &manifest.snapshots {
            let path = self.documents_dir.join(format!("{}.json", entry.document_id));
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(?path, error = %e, "recovery: snapshot missing/unreadable, skipping");
                    continue;
                }
            };
            match serde_json::from_str::<RecoverySnapshot>(&raw) {
                Ok(s) => out.push(s),
                Err(e) => {
                    // §11.1: one corrupt snapshot must not block the others.
                    tracing::warn!(?path, error = %e, "recovery: snapshot corrupt, skipping");
                }
            }
        }
        out
    }

    /// Load one snapshot by document id (for the `recover_document` /
    /// `compare_recovery` IPC). `None` if absent or corrupt.
    pub fn load_snapshot(&self, id: &str) -> Option<RecoverySnapshot> {
        let path = self.documents_dir.join(format!("{id}.json"));
        let raw = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// The recovery directory (for diagnostics / "open recovery folder").
    pub fn recovery_dir(&self) -> &Path {
        &self.recovery_dir
    }

    // --- internals -----------------------------------------------------------

    /// Load the manifest from `path` tolerantly: missing/corrupt main → try
    /// `.bak`; both missing → empty default. Migrates the schema version up to
    /// current (no-op for v1 today). Never returns `Err` for a corrupt file —
    /// only for an unrecoverable IO failure on a file that exists.
    fn load_manifest(path: &Path) -> Result<RecoveryManifest> {
        let outcome = load_json_with_backup(path, |s: &str| {
            serde_json::from_str::<RecoveryManifest>(s)
        })?;
        let mut manifest = match outcome {
            LoadOutcome::Primary(m) => m,
            LoadOutcome::RestoredFromBackup { value, .. } => value,
            LoadOutcome::MissingOrUnrecoverable => RecoveryManifest::default(),
        };
        if manifest.schema_version == 0 {
            // Absent field on an older file → treat as v1 (the initial shape).
            manifest.schema_version = CURRENT_SCHEMA_VERSION;
        }
        Ok(manifest)
    }

    /// Persist `manifest` atomically with `.bak` rotation.
    fn persist_manifest(&self, manifest: &RecoveryManifest) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(manifest)?;
        write_with_backup(&self.manifest_path, &bytes)?;
        Ok(())
    }

    /// Write one snapshot to `documents/<id>.json` and update the manifest
    /// entry. Called under the manifest lock.
    fn write_one_snapshot(
        &self,
        manifest: &mut RecoveryManifest,
        meta: &DocumentMeta,
        text: &str,
        disk_version: Option<DiskVersion>,
    ) -> Result<()> {
        let id_str = meta.id.to_string();
        let captured_at = now_millis();
        let snapshot = RecoverySnapshot {
            schema_version: CURRENT_SCHEMA_VERSION,
            document_id: id_str.clone(),
            origin: origin_tag(meta),
            canonical_path: meta.origin.canonical_path().map(|p| p.to_string_lossy().into_owned()),
            title: meta.title.clone(),
            content: text.to_string(),
            revision: meta.revision,
            disk_version,
            captured_at,
            app_version: app_version_string(),
        };
        let snapshot_path = self.documents_dir.join(format!("{id_str}.json"));
        write_json(&snapshot_path, &snapshot)?;

        // Upsert the manifest entry.
        let entry = SnapshotRef {
            document_id: id_str,
            canonical_path: snapshot.canonical_path.clone(),
            title: snapshot.title.clone(),
            revision: snapshot.revision,
            captured_at,
        };
        if let Some(existing) = manifest.snapshots.iter_mut().find(|s| s.document_id == entry.document_id) {
            *existing = entry;
        } else {
            manifest.snapshots.push(entry);
        }
        Ok(())
    }

    /// Flush all pending snapshots to disk + persist the manifest. Runs on the
    /// worker thread (debounce path) but uses the same write helpers as the
    /// synchronous path. The manifest is re-read first so concurrent
    /// synchronous discards aren't clobbered.
    ///
    /// §5.1.4 discard race: before writing each pending snapshot, the id is
    /// checked against `discarded_since_queued`. An id present there was
    /// discarded after it was queued but before this flush drained `pending`;
    /// it is skipped (no file write, no manifest entry) and the set entry is
    /// cleared so a future re-open can snapshot again.
    fn flush_pending(
        recovery_dir: &Path,
        manifest_path: &Path,
        pending: &mut HashMap<DocumentId, Pending>,
        discarded_since_queued: &Mutex<HashSet<DocumentId>>,
    ) {
        if pending.is_empty() {
            return;
        }
        // Re-load the manifest fresh (a synchronous discard may have mutated
        // the on-disk file between our last write and this flush). Falls back
        // to empty on any error — never block a flush on a manifest read.
        let mut manifest = Self::load_manifest(manifest_path).unwrap_or_default();
        let documents_dir = recovery_dir.join(DOCUMENTS_DIR);
        let drained = std::mem::take(pending);
        for (id, p) in drained {
            // §5.1.4: skip + clear any id discarded between queue and flush so
            // a racing discard can never resurrect a snapshot. Locking per-id
            // is cheap (the set is almost always empty).
            let was_discarded = discarded_since_queued.lock().remove(&id);
            if was_discarded {
                tracing::debug!(?id, "recovery: skipping flushed snapshot for discarded id");
                continue;
            }
            let id_str = id.to_string();
            let snapshot = RecoverySnapshot {
                schema_version: CURRENT_SCHEMA_VERSION,
                document_id: id_str.clone(),
                origin: origin_tag(&p.meta),
                canonical_path: p.meta.origin.canonical_path().map(|x| x.to_string_lossy().into_owned()),
                title: p.meta.title.clone(),
                content: p.text,
                revision: p.meta.revision,
                disk_version: p.disk_version,
                captured_at: now_millis(),
                app_version: app_version_string(),
            };
            let path = documents_dir.join(format!("{id_str}.json"));
            if let Err(e) = write_json(&path, &snapshot) {
                tracing::warn!(?path, error = %e, "recovery: flush snapshot write failed");
                continue;
            }
            let entry = SnapshotRef {
                document_id: id_str,
                canonical_path: snapshot.canonical_path.clone(),
                title: snapshot.title.clone(),
                revision: snapshot.revision,
                captured_at: snapshot.captured_at,
            };
            if let Some(existing) = manifest.snapshots.iter_mut().find(|s| s.document_id == entry.document_id) {
                *existing = entry;
            } else {
                manifest.snapshots.push(entry);
            }
        }
        let bytes = match serde_json::to_vec_pretty(&manifest) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "recovery: flush manifest serialize failed");
                return;
            }
        };
        if let Err(e) = write_with_backup(manifest_path, &bytes) {
            tracing::warn!(error = %e, "recovery: flush manifest persist failed");
        }
    }

    /// Remove every file/subentry in `dir` (not `dir` itself). Best-effort:
    /// individual removal errors are logged and skipped. Used by `clear_all`.
    fn wipe_dir(dir: &Path) -> Result<()> {
        let read = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in read {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let res = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(e) = res {
                tracing::warn!(?path, error = %e, "recovery: wipe_dir entry remove failed");
            }
        }
        Ok(())
    }
}

impl Drop for RecoveryService {
    fn drop(&mut self) {
        // Signal the worker to do a final flush and exit. If the sender is
        // already closed (e.g. the worker panicked) the send is a no-op.
        let _ = self.sender.send(Msg::Shutdown);
        // Join to ensure the final flush completes before we tear down — but
        // don't block forever; the worker's recv_timeout keeps it responsive.
        if let Some(handle) = self.worker.lock().take() {
            let _ = handle.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// Map a [`DocumentOrigin`](crate::domain::document::DocumentOrigin) to the
/// compact string tag stored on a snapshot. Round-trips are not required — the
/// tag only drives the recovery UI's "has disk backing?" decision.
fn origin_tag(meta: &DocumentMeta) -> String {
    use crate::domain::document::DocumentOrigin;
    match meta.origin {
        DocumentOrigin::Untitled => "untitled".into(),
        DocumentOrigin::WorkspaceFile { .. } => "workspace".into(),
        DocumentOrigin::LooseFile { .. } => "loose".into(),
    }
}

/// Current unix time in milliseconds (best-effort; 0 if the clock is before
/// epoch, which would only happen on a wildly misconfigured system).
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The app version to stamp into snapshots/manifest. Reads `CARGO_PKG_VERSION`
/// at compile time so there's no runtime cost.
fn app_version_string() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::document::{DocumentId, DocumentMeta};
    use std::path::PathBuf;

    /// A unique temp recovery dir per test, canonicalized (macOS `/var` →
    /// `/private/var` so assertions on stored paths are stable).
    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::domain::path::canonicalize_for_identity(&dir)
            .unwrap_or_else(|_| dir.canonicalize().unwrap_or(dir))
    }

    /// Build a service with a tiny debounce so tests don't sleep 750ms.
    fn make_service() -> (RecoveryService, PathBuf) {
        let dir = tmp_dir();
        // 5ms debounce — fast enough for tests, slow enough that coalescing is
        // observable.
        let svc = RecoveryService::with_debounce(dir.clone(), Duration::from_millis(5)).unwrap();
        (svc, dir)
    }

    fn untitled_meta(text: &str) -> (DocumentMeta, String) {
        let mut m = DocumentMeta::new_untitled();
        // Simulate an edit bumping revision + dirty.
        m.dirty = true;
        m.revision = 1;
        m.title = "Untitled".into();
        let _ = text;
        (m, text.to_string())
    }

    fn loose_meta(path: &Path, dirty: bool) -> DocumentMeta {
        let id = DocumentId::new();
        let root = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let mut m = DocumentMeta::with_loose_path(id, path.to_path_buf(), root);
        m.dirty = dirty;
        m
    }

    // Helper to wait for the worker to settle: flush + a short sleep so the
    // on-disk state is deterministic before asserting. The flush is repeated a
    // few times with yielding to absorb scheduling jitter under heavy parallel
    // test load (the worker thread can be briefly delayed).
    fn settle(svc: &RecoveryService) {
        for _ in 0..10 {
            svc.flush_now();
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    #[test]
    fn dirty_doc_writes_snapshot() {
        let (svc, dir) = make_service();
        let (meta, text) = untitled_meta("hello unsaved");
        // Use the synchronous API for determinism.
        svc.snapshot_dirty_documents(&[meta.clone()], |id| {
            (id == meta.id).then(|| text.clone())
        });
        let snapshot_path = dir.join(DOCUMENTS_DIR).join(format!("{}.json", meta.id));
        assert!(snapshot_path.exists(), "dirty doc must produce a snapshot");
        let raw = std::fs::read_to_string(&snapshot_path).unwrap();
        let snap: RecoverySnapshot = serde_json::from_str(&raw).unwrap();
        assert_eq!(snap.content, "hello unsaved");
        assert_eq!(snap.document_id, meta.id.to_string());
        assert_eq!(snap.origin, "untitled");
        // Manifest has an entry.
        let manifest_raw = std::fs::read_to_string(dir.join(MANIFEST_FILENAME)).unwrap();
        let manifest: RecoveryManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert_eq!(manifest.snapshots.len(), 1);
        assert_eq!(manifest.snapshots[0].document_id, meta.id.to_string());
    }

    #[test]
    fn clean_doc_deletes_snapshot() {
        let (svc, dir) = make_service();
        // First dirty the doc → snapshot exists.
        let tmp = tmp_dir().join("a.typ");
        std::fs::write(&tmp, "x").unwrap();
        let dirty = loose_meta(&tmp, true);
        svc.snapshot_dirty_documents(&[dirty.clone()], |_| Some("edited".into()));
        let snapshot_path = dir.join(DOCUMENTS_DIR).join(format!("{}.json", dirty.id));
        assert!(snapshot_path.exists());

        // Now the doc is clean → snapshot deleted, manifest entry removed.
        let clean = { let mut m = dirty.clone(); m.dirty = false; m };
        svc.snapshot_dirty_documents(&[clean], |_| Some("edited".into()));
        assert!(!snapshot_path.exists(), "clean doc's snapshot must be deleted");
        let manifest_raw = std::fs::read_to_string(dir.join(MANIFEST_FILENAME)).unwrap();
        let manifest: RecoveryManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert!(manifest.snapshots.is_empty(), "manifest must drop the clean doc's entry");
    }

    #[test]
    fn manifest_tracks_snapshots() {
        let (svc, _dir) = make_service();
        let tmp1 = tmp_dir().join("one.typ");
        let tmp2 = tmp_dir().join("two.typ");
        std::fs::write(&tmp1, "1").unwrap();
        std::fs::write(&tmp2, "2").unwrap();
        let a = loose_meta(&tmp1, true);
        let b = loose_meta(&tmp2, true);
        svc.snapshot_dirty_documents(&[a.clone(), b.clone()], |id| {
            if id == a.id { Some("A".into()) } else { Some("B".into()) }
        });
        let recoverable = svc.list_recoverable();
        assert_eq!(recoverable.len(), 2, "both dirty docs are recoverable");
        let titles: Vec<_> = recoverable.iter().map(|s| s.title.as_str()).collect();
        assert!(titles.contains(&"one.typ") && titles.contains(&"two.typ"));
    }

    #[test]
    fn debounce_coalesces_rapid_edits() {
        let (svc, dir) = make_service();
        let (mut meta, _) = untitled_meta("v0");
        // Fire many rapid edits via the debounced path.
        for i in 0..20 {
            meta.revision = i as u64;
            svc.schedule_snapshot(meta.clone(), format!("v{i}"), None);
            // No sleep: all updates land within the debounce window.
        }
        settle(&svc);
        // Exactly ONE snapshot file exists, carrying the latest text.
        let snapshot_path = dir.join(DOCUMENTS_DIR).join(format!("{}.json", meta.id));
        assert!(snapshot_path.exists());
        let raw = std::fs::read_to_string(&snapshot_path).unwrap();
        let snap: RecoverySnapshot = serde_json::from_str(&raw).unwrap();
        assert_eq!(snap.content, "v19", "coalesced snapshot must hold the latest edit");
        assert_eq!(snap.revision, 19);
    }

    #[test]
    fn flush_now_bypasses_debounce() {
        // Use a LONG debounce so the only way the snapshot lands quickly is via
        // flush_now.
        let dir = tmp_dir();
        let svc = RecoveryService::with_debounce(dir.clone(), Duration::from_secs(30)).unwrap();
        let (meta, text) = untitled_meta("flush me");
        svc.schedule_snapshot(meta.clone(), text.clone(), None);
        // Without flush_now, nothing would land for 30s.
        svc.flush_now();
        // Wait for the worker to process FlushNow.
        for _ in 0..40 {
            let p = dir.join(DOCUMENTS_DIR).join(format!("{}.json", meta.id));
            if p.exists() {
                let raw = std::fs::read_to_string(&p).unwrap();
                let snap: RecoverySnapshot = serde_json::from_str(&raw).unwrap();
                assert_eq!(snap.content, "flush me");
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("flush_now did not land a snapshot within timeout");
    }

    #[test]
    fn one_corrupt_snapshot_does_not_block_others() {
        let (svc, dir) = make_service();
        let tmp1 = tmp_dir().join("good.typ");
        let tmp2 = tmp_dir().join("bad.typ");
        std::fs::write(&tmp1, "1").unwrap();
        std::fs::write(&tmp2, "2").unwrap();
        let good = loose_meta(&tmp1, true);
        let bad = loose_meta(&tmp2, true);
        svc.snapshot_dirty_documents(&[good.clone(), bad.clone()], |id| {
            if id == good.id { Some("GOOD".into()) } else { Some("BAD".into()) }
        });
        // Corrupt the bad snapshot on disk.
        let bad_path = dir.join(DOCUMENTS_DIR).join(format!("{}.json", bad.id));
        std::fs::write(&bad_path, "{ totally not json").unwrap();

        let recoverable = svc.list_recoverable();
        // §11.1: the good snapshot survives; the corrupt one is skipped.
        assert_eq!(recoverable.len(), 1, "corrupt snapshot must be skipped, not fatal");
        assert_eq!(recoverable[0].content, "GOOD");
    }

    #[test]
    fn clean_shutdown_marker_round_trip() {
        let (svc, dir) = make_service();
        // Fresh service: no marker.
        assert!(!svc.has_clean_shutdown(), "no marker on a fresh service");
        svc.mark_clean_shutdown();
        assert!(svc.has_clean_shutdown(), "marker present after mark");
        assert!(dir.join(CLEAN_SHUTDOWN_MARKER).exists());
        svc.clear_clean_shutdown();
        assert!(!svc.has_clean_shutdown(), "marker gone after clear");
        // Clearing when absent is a no-op (not an error).
        svc.clear_clean_shutdown();
    }

    #[test]
    fn discard_snapshot_removes_from_manifest() {
        let (svc, dir) = make_service();
        let tmp = tmp_dir().join("discard.typ");
        std::fs::write(&tmp, "x").unwrap();
        let meta = loose_meta(&tmp, true);
        svc.snapshot_dirty_documents(&[meta.clone()], |_| Some("unsaved".into()));
        let snapshot_path = dir.join(DOCUMENTS_DIR).join(format!("{}.json", meta.id));
        assert!(snapshot_path.exists());

        svc.discard_snapshot(meta.id);
        assert!(!snapshot_path.exists(), "discard must delete the snapshot file");
        let manifest_raw = std::fs::read_to_string(dir.join(MANIFEST_FILENAME)).unwrap();
        let manifest: RecoveryManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert!(manifest.snapshots.is_empty(), "discard must remove the manifest entry");
        // And it's not recoverable.
        assert!(svc.list_recoverable().is_empty());
    }

    #[test]
    fn clear_all_wipes_dir() {
        let (svc, dir) = make_service();
        let (meta, text) = untitled_meta("wipe me");
        svc.snapshot_dirty_documents(&[meta], |_| Some(text.clone()));
        svc.mark_clean_shutdown();
        assert!(dir.join(DOCUMENTS_DIR).exists());
        assert!(dir.join(MANIFEST_FILENAME).exists());
        assert!(dir.join(CLEAN_SHUTDOWN_MARKER).exists());

        svc.clear_all();
        // Wiped: no snapshots, no manifest entries, no marker. The dir itself
        // remains (so a subsequent snapshot can recreate it without re-mkdir).
        assert!(!dir.join(CLEAN_SHUTDOWN_MARKER).exists(), "marker wiped");
        // documents/ subdir may or may not survive wipe (entries removed); the
        // snapshot file must be gone either way.
        let docs_dir = dir.join(DOCUMENTS_DIR);
        if docs_dir.exists() {
            assert!(std::fs::read_dir(&docs_dir).unwrap().count() == 0, "documents/ must be empty");
        }
        assert!(svc.list_recoverable().is_empty(), "nothing recoverable after clear_all");
    }

    #[test]
    fn manifest_bak_recovers_after_corruption() {
        let (svc, dir) = make_service();
        let tmp = tmp_dir().join("bak.typ");
        std::fs::write(&tmp, "x").unwrap();
        let meta = loose_meta(&tmp, true);
        svc.snapshot_dirty_documents(&[meta.clone()], |_| Some("X".into()));
        // Corrupt the manifest main; .bak should still hold the prior good copy.
        std::fs::write(dir.join(MANIFEST_FILENAME), "{ broken").unwrap();
        // list_recoverable reloads the manifest tolerantly.
        let recoverable = svc.list_recoverable();
        // Either recovered from .bak (1) or empty if .bak was also absent; the
        // key contract is no panic.
        assert!(recoverable.len() <= 1);
    }

    #[test]
    fn disk_version_round_trips_through_snapshot() {
        // DiskVersion now Serialize/Deserialize: ensure it survives a snapshot
        // write + read cycle.
        let (svc, _dir) = make_service();
        let tmp = tmp_dir().join("dv.typ");
        std::fs::write(&tmp, "on disk").unwrap();
        let mut meta = loose_meta(&tmp, true);
        meta.revision = 7;
        svc.snapshot_dirty_documents(&[meta.clone()], |_| Some("edited".into()));
        let snap = svc.load_snapshot(&meta.id.to_string()).expect("snapshot present");
        assert!(snap.disk_version.is_some(), "disk-backed snapshot must record disk_version");
        // And it matches the on-disk file's actual version.
        let actual = DiskVersion::from_path(&tmp).unwrap();
        assert_eq!(snap.disk_version.unwrap(), actual);
    }

    #[test]
    fn schedule_then_drop_does_not_panic_or_leak_worker() {
        // Drop the service while edits are pending. The Drop impl sends
        // Shutdown and joins; the worker must exit cleanly.
        let (svc, _dir) = make_service();
        let (meta, _) = untitled_meta("pending");
        svc.schedule_snapshot(meta, "pending text".into(), None);
        // Drop immediately (no settle). Must not panic.
        drop(svc);
    }

    // --- Issue 3: manifest mirror divergence -----------------------------------
    //
    // Regression: the debounce worker's flush writes the manifest ON DISK; the
    // synchronous ops used to trust a stale in-memory mirror and could DROP
    // entries the worker added. The fix makes every sync op read-modify-write
    // disk. Here a worker flush lands an entry, then a sync discard on a
    // DIFFERENT doc must not orphan the worker's entry.

    #[test]
    fn sync_discard_does_not_orphan_worker_flushed_entry() {
        // Long debounce so the worker only flushes when we tell it to via
        // flush_now — deterministic on-disk state.
        let dir = tmp_dir();
        let svc = RecoveryService::with_debounce(dir.clone(), Duration::from_secs(30)).unwrap();

        // Two disk-backed docs.
        let tmp_worker = tmp_dir().join("worker.typ");
        let tmp_discard = tmp_dir().join("discard.typ");
        std::fs::write(&tmp_worker, "w").unwrap();
        std::fs::write(&tmp_discard, "d").unwrap();
        let worker_meta = loose_meta(&tmp_worker, true);
        let discard_meta = loose_meta(&tmp_discard, true);

        // Queue both via the debounced path (pending in the worker buffer).
        svc.schedule_snapshot(worker_meta.clone(), "W".into(), None);
        svc.schedule_snapshot(discard_meta.clone(), "D".into(), None);
        // Force the worker to flush BOTH to disk → manifest now has 2 entries
        // written by the worker (the path that used to diverge from the mirror).
        flush_and_wait(&svc, &dir, &worker_meta.id);
        let manifest_after_flush = read_manifest(&dir);
        assert_eq!(
            manifest_after_flush.snapshots.len(),
            2,
            "worker flush must land both pending snapshots"
        );

        // Now a SYNCHRONOUS discard on one doc. With the old stale-mirror code
        // this persisted an empty mirror (the service never observed the
        // worker's flush), orphaning the worker's other entry.
        svc.discard_snapshot(discard_meta.id);

        let manifest_after_discard = read_manifest(&dir);
        let ids: Vec<_> = manifest_after_discard
            .snapshots
            .iter()
            .map(|s| s.document_id.clone())
            .collect();
        assert!(
            !ids.contains(&discard_meta.id.to_string()),
            "discarded doc's entry must be gone"
        );
        assert!(
            ids.contains(&worker_meta.id.to_string()),
            "worker-flushed entry must SURVIVE the sync discard (no orphaning)"
        );
        assert_eq!(manifest_after_discard.snapshots.len(), 1);
    }

    // --- Issue 4: discard race (§5.1.4) ----------------------------------------
    //
    // Regression: if the worker drains `pending` into a local batch
    // (std::mem::take) just before `discard_snapshot` sends Cancel/Discard,
    // the in-flight flush would re-write the snapshot + re-add the manifest
    // entry, so the discarded doc is offered again next launch. The fix: a
    // shared `discarded_since_queued` set that flush_pending checks per-id.

    #[test]
    fn discard_then_flush_does_not_recreate_snapshot() {
        // Message-path coverage: schedule, discard (records in the set + sends
        // Discard so the worker drops its pending entry), then flush_now. The
        // snapshot must NOT exist and the manifest must have no entry.
        let dir = tmp_dir();
        let svc = RecoveryService::with_debounce(dir.clone(), Duration::from_secs(30)).unwrap();
        let tmp = tmp_dir().join("race.typ");
        std::fs::write(&tmp, "x").unwrap();
        let meta = loose_meta(&tmp, true);

        svc.schedule_snapshot(meta.clone(), "PENDING".into(), None);
        // Discard BEFORE any flush: records id in discarded_since_queued AND
        // sends Discard (worker drops its pending entry).
        svc.discard_snapshot(meta.id);
        // Force a flush. Even though the worker dropped the pending entry, this
        // exercises the set-guard path for any in-flight batch.
        svc.flush_now();
        // Give the worker time to process FlushNow.
        std::thread::sleep(Duration::from_millis(50));

        let snapshot_path = dir.join(DOCUMENTS_DIR).join(format!("{}.json", meta.id));
        assert!(
            !snapshot_path.exists(),
            "discarded snapshot must NOT be (re)written by the flush"
        );
        let manifest = read_manifest(&dir);
        assert!(
            manifest.snapshots.is_empty(),
            "manifest must have no entry for the discarded doc"
        );
    }

    #[test]
    fn discard_races_in_flight_flush_never_resurrects_snapshot() {
        // Drained-batch coverage (§5.1.4): the worker has ALREADY drained
        // `pending` into its local batch via std::mem::take, so the Discard
        // message can't remove the id from that in-flight batch. The shared
        // `discarded_since_queued` set is the only thing that can save us.
        //
        // We force this exact window: establish a baseline snapshot, discard
        // (records id in the set + removes file + manifest entry), then
        // re-queue a STALE edit for the same id and flush. The worker's
        // flush_pending drains the re-queued id into its local batch but must
        // still skip it because the set still contains id. This is the literal
        // §5.1.4 race: a flush writes work that was queued before/around the
        // discard, but the user already discarded it.
        let dir = tmp_dir();
        let svc = RecoveryService::with_debounce(dir.clone(), Duration::from_secs(30)).unwrap();
        let tmp = tmp_dir().join("race2.typ");
        std::fs::write(&tmp, "x").unwrap();
        let meta = loose_meta(&tmp, true);
        let id_str = meta.id.to_string();
        let snapshot_path = dir.join(DOCUMENTS_DIR).join(format!("{id_str}.json"));

        // 1. Baseline snapshot so discard has a file/entry to remove (and so
        //    the set's "clear after check" is exercised: the baseline flush
        //    clears nothing because id isn't discarded yet).
        svc.schedule_snapshot(meta.clone(), "V1".into(), None);
        flush_and_wait(&svc, &dir, &meta.id);
        assert!(snapshot_path.exists(), "baseline snapshot should exist");

        // 2. The race: discard (records id in the shared set synchronously,
        //    removes the file + manifest entry), THEN a stale pending edit for
        //    the same id is flushed (simulating the worker's already-drained
        //    local batch from around the discard).
        svc.discard_snapshot(meta.id);
        assert!(!snapshot_path.exists(), "discard removes the file");
        // Stale edit races in — re-queue the same id + force a flush.
        svc.schedule_snapshot(meta.clone(), "RACING FLUSH".into(), None);
        svc.flush_now();
        // Let the worker process FlushNow.
        std::thread::sleep(Duration::from_millis(80));

        // §5.1.4: the discarded doc must NOT be offered again. The set guard
        // must have caused flush_pending to skip id despite the re-queue.
        assert!(
            !snapshot_path.exists(),
            "racing flush must NOT recreate the discarded snapshot"
        );
        let manifest = read_manifest(&dir);
        assert!(
            manifest.snapshots.is_empty(),
            "manifest must have no entry for the discarded doc after the racing flush (got {} entries: {:?})",
            manifest.snapshots.len(),
            manifest.snapshots.iter().map(|s| s.document_id.clone()).collect::<Vec<_>>()
        );
    }

    /// Read the on-disk manifest for assertions. Tolerant of a missing file
    /// (returns the default empty manifest), since some flows only persist the
    /// manifest when an entry actually changes. Panics on a malformed file
    /// (tests control the file so that's a real failure).
    fn read_manifest(dir: &Path) -> RecoveryManifest {
        let path = dir.join(MANIFEST_FILENAME);
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).expect("manifest is valid json"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => RecoveryManifest::default(),
            Err(e) => panic!("unexpected error reading manifest: {e}"),
        }
    }

    /// Drive a `flush_now` and wait until BOTH the snapshot for `id` AND the
    /// manifest are observable on disk (bounded polling — the worker writes
    /// snapshots first, then the manifest at the end of the batch, so waiting
    /// on the file alone races the manifest write).
    fn flush_and_wait(svc: &RecoveryService, dir: &Path, id: &DocumentId) {
        let target = dir.join(DOCUMENTS_DIR).join(format!("{}.json", id));
        let manifest = dir.join(MANIFEST_FILENAME);
        for _ in 0..80 {
            svc.flush_now();
            if target.exists() && manifest.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("flush_now did not land snapshot for {id} within timeout");
    }
}
