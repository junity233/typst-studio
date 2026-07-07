//! `TabStore` — the shared internal state backing [`DocumentService`] and
//! [`CompileService`] (§6.1 / §6.3).
//!
//! Phase 4 splits the old monolithic [`EditorService`](super::editor_service::EditorService)
//! into a document-identity service and a compile service. Several pieces of
//! state are inherently shared between the two concerns:
//!
//! - the `tabs` map (a document's buffer lives on its `TabState`, but compile
//!   reads from the same `tab.world` and writes results back to `tab.state`);
//! - the `workers` map (document lifecycle — open/close/save-as/reclassify —
//!   spawns and rotates compile workers);
//! - the `registry` (document identity, consulted by both open and compile paths);
//! - the loose-file resolver + watcher caches and the shared in-memory VFS.
//!
//! Rather than force an artificial ownership boundary on day one (and risk the
//! `Arc<EditorService>` cycle the original design worked hard to avoid), both
//! services hold an [`Arc<TabStore>`]. This keeps the watcher callbacks and the
//! compile closures capturing only the shared `Arc`s — exactly the discipline the
//! pre-split code already maintained. The split is therefore *structural* (two
//! real services exist, each with its own method surface) without a hermetic
//! field partition; tightening that boundary is follow-up work.
//!
//! [`Arc<TabStore>`]: std::sync::Arc

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;

use crate::domain::document::{ConflictState, DocumentId, DocumentMeta, DocumentOrigin};
use crate::domain::registry::{DocumentRegistry, SharedRegistry};
use crate::fs::watcher;
use crate::typst_engine::MemoryVfs;

use super::compile_supervisor::CompileSupervisor;
use super::compile_worker::CompileWorker;
use super::editor_service::Emitter;
use super::tab_state::TabState;
use super::workspace_service::WorkspaceService;

/// Shared tab map. The world is NOT behind a per-tab Mutex (it has its own
/// interior `RwLock<Source>`), so compile can proceed without holding any
/// tab-level lock — eliminating contention between typing and compiling.
pub type Tabs = Arc<RwLock<HashMap<DocumentId, Arc<TabState>>>>;
/// Per-tab compile workers (one long-lived thread each).
pub type Workers = Arc<RwLock<HashMap<DocumentId, CompileWorker>>>;
/// Cache of [`FileResolver`]s for loose files, keyed by parent directory.
/// Files in the same directory share one resolver so same-dir `#include` /
/// `#image()` resolve consistently (§4.2 LooseFile). `FileResolver` is cheap to
/// clone (root behind an `Arc<RwLock<PathBuf>>`), so a clone is handed to each
/// tab's [`EditorWorld`](crate::typst_engine::world::EditorWorld).
pub type LooseResolvers = Arc<RwLock<HashMap<PathBuf, crate::fs::FileResolver>>>;

/// Per-parent-directory filesystem watchers for loose files OUTSIDE the active
/// workspace (§4.2 / §8.4). The workspace's own watcher covers in-workspace
/// files, so this cache only ever holds parents that are NOT inside the
/// workspace root. Same-dir loose files share one watcher (keyed by parent),
/// mirroring the [`TabStore::loose_resolvers`] cache.
///
/// Bounded by the number of distinct out-of-workspace directories the user has
/// opened — not unbounded. Watchers are left alive on tab close for B2 (small
/// per-directory cost).
pub type LooseWatchers = Arc<RwLock<HashMap<PathBuf, watcher::WatcherGuard>>>;

/// The shared, concurrently-accessed backing store for both
/// [`DocumentService`](super::document_service::DocumentService) and
/// [`CompileService`](super::compile_service::CompileService).
///
/// Every field is behind an `Arc`-shared lock so the watcher `on_change`
/// callbacks and the compile-worker closures can capture clones of just these
/// `Arc`s (never an `Arc` to a service — that would reintroduce the cycle the
/// pre-split design avoided).
#[derive(Clone)]
pub struct TabStore {
    pub tabs: Tabs,
    pub workers: Workers,
    pub registry: SharedRegistry,
    /// Parent-directory-rooted resolvers for loose files (§4.2). Shared so two
    /// tabs whose files live in the same directory anchor against one root.
    pub loose_resolvers: LooseResolvers,
    /// Per-parent-dir watchers for out-of-workspace loose files (§4.2 / §8.4).
    pub loose_watchers: LooseWatchers,
    /// Shared in-memory overlay of open documents' buffers (§5 end). Keyed by
    /// canonical disk path. Each tab's [`EditorWorld`] gets a clone of this
    /// `Arc` so that a `#include`d file which is also an open document compiles
    /// from its live (possibly unsaved) buffer rather than the stale disk copy.
    /// The main document's own buffer is served from the world's `source`
    /// directly, so it is deliberately NOT inserted here.
    pub vfs: Arc<MemoryVfs>,
    pub emitter: Arc<dyn Emitter>,
    /// Process-wide compile supervision (§6.2): the concurrency-limiting
    /// semaphore + the shutdown flag. Shared into each worker's compile closure
    /// so the cap applies across all tabs. Defaults to a fresh supervisor with
    /// the policy-derived cap; tests can inject a custom one.
    pub supervisor: CompileSupervisor,
}

impl TabStore {
    /// Construct a fresh empty store with the given emitter.
    pub fn new(emitter: Arc<dyn Emitter>) -> Self {
        Self {
            tabs: Arc::new(RwLock::new(HashMap::new())),
            workers: Arc::new(RwLock::new(HashMap::new())),
            registry: Arc::new(RwLock::new(DocumentRegistry::new())),
            loose_resolvers: Arc::new(RwLock::new(HashMap::new())),
            loose_watchers: Arc::new(RwLock::new(HashMap::new())),
            vfs: Arc::new(MemoryVfs::new()),
            emitter,
            supervisor: CompileSupervisor::new(),
        }
    }

    /// Read-only access to the document registry (for the IPC layer to detect
    /// "already open" before creating a duplicate).
    pub fn registry(&self) -> &SharedRegistry {
        &self.registry
    }
}

// --- shared free-function helpers (moved verbatim from the pre-split editor
//     service so both DocumentService and CompileService can route through them)
//     --------------------------------------------------------------

/// Return the existing metadata for an already-open canonical path, if any.
/// Used by the open path to deduplicate before creating a new document.
pub(crate) fn find_existing(store: &TabStore, canon: &Path) -> Option<DocumentMeta> {
    let id = store.registry.read().find_by_canonical(canon)?;

    // The registry owns identity/path indexing, but its metadata is only a
    // registration snapshot. Revision, dirty, and conflict evolve on the live
    // TabState. Reopening an already-open document must return that live
    // metadata; otherwise the frontend restarts at revision 0 and later edits
    // and exports are rejected by the backend as stale.
    if let Some(tab) = store.tabs.read().get(&id).cloned() {
        return Some(tab.state.lock().meta.clone());
    }

    // Defensive fallback for a temporarily inconsistent store. The normal
    // invariant is that every registered id has a matching TabState.
    store.registry.read().get(id).cloned()
}

/// Classify a fresh on-disk path as `WorkspaceFile` or `LooseFile` (§4.2).
/// When `workspace` is open and contains `canon`, the file is a
/// `WorkspaceFile` carrying the workspace's id; otherwise it is a `LooseFile`
/// rooted at its parent directory.
pub(crate) fn classify_new(
    id: DocumentId,
    canon: PathBuf,
    workspace: Option<&WorkspaceService>,
) -> DocumentMeta {
    if let Some(ws) = workspace {
        if let Some(workspace_id) = ws.workspace_id() {
            if ws.contains(&canon) {
                return DocumentMeta::with_workspace_path(id, canon, workspace_id);
            }
        }
    }
    let root = canon
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    DocumentMeta::with_loose_path(id, canon, root)
}

/// Look up (or insert) the shared [`FileResolver`] for a loose-file parent
/// directory, and return a cheap clone (§4.2). Two loose files in the same
/// directory share one resolver so their relative-include resolution is
/// consistent and the cache stays small.
pub(crate) fn loose_resolver_for(
    store: &TabStore,
    parent: &Path,
) -> crate::fs::FileResolver {
    if let Some(r) = store.loose_resolvers.read().get(parent) {
        return r.clone();
    }
    let resolver = crate::fs::FileResolver::new(parent.to_path_buf());
    // Another thread may have inserted concurrently; the last writer wins,
    // but both resolvers anchor the same root, so it's harmless.
    store
        .loose_resolvers
        .write()
        .entry(parent.to_path_buf())
        .or_insert(resolver)
        .clone()
}

/// Look up (or insert) the parent-directory watcher for a loose file outside
/// the active workspace (§4.2 / §8.4). Same-dir loose files share one watcher.
/// The watcher's `on_change` routes changed paths into [`handle_external_change`]
/// (it does NOT emit `fs_changed` — that event is workspace-tree-only, and these
/// dirs are by definition outside the workspace). Best-effort: a watcher failure
/// is logged and skipped (the cache entry is simply not inserted).
pub(crate) fn loose_watcher_for(store: &TabStore, parent: &Path) {
    if store.loose_watchers.read().contains_key(parent) {
        return;
    }
    // The callback only needs the shared store to route into
    // handle_external_change. It captures the shared `Arc`s (NOT a service Arc —
    // that would be a cycle), so the closure stays 'static + Send + Sync.
    let tabs = store.tabs.clone();
    let workers = store.workers.clone();
    let registry = store.registry.clone();
    let vfs = store.vfs.clone();
    let emitter = store.emitter.clone();
    let on_change: watcher::OnChange = Arc::new(move |paths: &[PathBuf]| {
        for p in paths {
            handle_external_change_locked(p, &tabs, &registry, &workers, &vfs, &emitter);
        }
    });
    match watcher::watch(parent, watcher::DEFAULT_DEBOUNCE, on_change) {
        Ok(guard) => {
            store
                .loose_watchers
                .write()
                .entry(parent.to_path_buf())
                .or_insert(guard);
        }
        // A watcher failure is non-fatal — the file still edits, just without
        // live external-change detection. Log and continue.
        Err(e) => tracing::warn!("could not start loose-file watcher for {parent:?}: {e}"),
    }
}

/// Helper: set a tab's conflict state and emit the corresponding event. Holds
/// the runtime lock only long enough to update `meta.conflict`.
pub(crate) fn set_conflict(
    tab: &Arc<TabState>,
    id: DocumentId,
    emitter: &Arc<dyn Emitter>,
    conflict: ConflictState,
    disk_content: Option<String>,
) {
    let revision = {
        let mut rt = tab.state.lock();
        rt.meta.conflict = conflict;
        rt.meta.revision
    };
    emitter.emit_conflict(id, revision, conflict, disk_content);
}

/// Decide the reclassified [`DocumentOrigin`] for a doc currently at `canon`,
/// given the workspace state. Returns `None` when the origin is already correct
/// (no transition needed).
///
/// Rules (§4.3):
/// - Workspace open + doc contained → `WorkspaceFile` with the current id.
/// - Workspace open + doc NOT contained → `LooseFile` rooted at its parent.
/// - Workspace closed + doc was a `WorkspaceFile` → `LooseFile` rooted at its
///   parent.
/// - Workspace closed + doc already `LooseFile` → unchanged (`None`).
pub(crate) fn reclassified_origin(
    current: &DocumentOrigin,
    canon: &Path,
    ws: &WorkspaceService,
) -> Option<DocumentOrigin> {
    let parent = canon
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    if ws.is_open() {
        if let Some(workspace_id) = ws.workspace_id() {
            if ws.contains(canon) {
                // Belongs to the current workspace.
                let target = DocumentOrigin::WorkspaceFile {
                    path: canon.to_path_buf(),
                    workspace_id,
                };
                // Transition iff the target differs from the current origin.
                return (&target != current).then_some(target);
            }
        }
        // Workspace open but the file is outside it → loose.
        let target = DocumentOrigin::LooseFile {
            path: canon.to_path_buf(),
            root: parent,
        };
        return (&target != current).then_some(target);
    }

    // No workspace open: any WorkspaceFile must demote to LooseFile.
    match current {
        DocumentOrigin::WorkspaceFile { .. } => {
            let target = DocumentOrigin::LooseFile {
                path: canon.to_path_buf(),
                root: parent,
            };
            Some(target)
        }
        // Already loose (or untitled, which is filtered out earlier).
        _ => None,
    }
}

/// Pick the [`FileResolver`] matching an origin's resolution scope. Returns the
/// workspace resolver for a `WorkspaceFile`, the (cached) parent resolver for a
/// `LooseFile`, and `None` for `Untitled`. `loose_for` resolves the loose
/// resolver (so the caller can route through the shared cache).
pub(crate) fn resolver_for_origin(
    origin: &DocumentOrigin,
    ws: &WorkspaceService,
    loose_for: impl Fn(&Path) -> crate::fs::FileResolver,
) -> Option<crate::fs::FileResolver> {
    match origin {
        DocumentOrigin::WorkspaceFile { .. } => ws.resolver(),
        DocumentOrigin::LooseFile { root, .. } => Some(loose_for(root)),
        DocumentOrigin::Untitled => None,
    }
}

/// Whether `path` exists on disk (any type — file, dir, symlink target). Used
/// by [`handle_external_change_locked`] to distinguish a genuine deletion
/// (`NotFound` + path truly gone) from a transient read failure.
pub(crate) fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

use crate::domain::disk_version::{DiskVersion, FileIdentity};
use crate::domain::path::canonicalize_for_identity;

/// The shared core of the external-modification handler, callable from the
/// loose-file watcher's `on_change` callback (which holds clones of the `Arc`
/// fields rather than a service). Implements the §8.4 rules.
///
/// Lock discipline mirrors `update_text`: brief locks, no nested cross-service
/// locks, the world text written via its own interior `RwLock` outside the
/// runtime mutex. Safe to run on the watcher flush thread concurrently with
/// compile workers and the IPC runtime.
pub(crate) fn handle_external_change_locked(
    path: &Path,
    tabs: &Tabs,
    registry: &SharedRegistry,
    workers: &Workers,
    vfs: &Arc<MemoryVfs>,
    emitter: &Arc<dyn Emitter>,
) {
    // Canonicalize the watcher's path so it compares against the registry's
    // canonical keys. `canonicalize_for_identity` does lexical normalization
    // then symlink resolution *only if the path exists*. For a DELETED file the
    // symlink step is skipped, so the lexical form may differ from the stored
    // canonical key (e.g. macOS `/var/...` vs the resolved `/private/var/...`).
    // We resolve the open document id by trying, in order: the canonicalized
    // path, the raw event path, and (for a deleted file whose parent still
    // exists) a canonicalized-parent + file-name join. The watcher is rooted at
    // a canonical dir, so the last fallback reconstructs the true canonical key
    // even when the file itself is gone.
    let canon = canonicalize_for_identity(path).ok();
    let id = {
        let reg = registry.read();
        canon
            .as_deref()
            .and_then(|c| reg.find_by_canonical(c))
            .or_else(|| reg.find_by_canonical(path))
            .or_else(|| {
                // Deleted-file fallback: canonicalize the (still-existing)
                // parent, then re-join the file name. If the parent is also
                // gone, this yields None and we treat the path as not-an-open-
                // document.
                let parent = path.parent()?;
                let canon_parent = canonicalize_for_identity(parent).ok()?;
                let name = path.file_name()?;
                reg.find_by_canonical(&canon_parent.join(name))
            })
    };
    let Some(id) = id else {
        return; // not an open document — the frontend tree handles it.
    };

    let tab = match tabs.read().get(&id).cloned() {
        Some(t) => t,
        None => return,
    };

    // Read the new on-disk version. Distinguish THREE failure modes (§5.4):
    //   - NotFound → the file was deleted → `Missing`.
    //   - PermissionDenied → the file became read-only/inaccessible →
    //     `PermissionChanged` (NEW in §5.4; previously lumped into the
    //     transient-error skip, so the user was never told their file became
    //     unreadable).
    //   - any other IO error → transient; skip (don't wrongly classify).
    // Try the canonical path first (it may still exist), then the raw event path.
    let read_result = read_disk_version(canon.as_deref().unwrap_or(path));
    // Fall back to the raw event path only if the canonical read wasn't a
    // definitive Ok (NotFound on the canonical path may simply mean the
    // canonicalization failed for a deleted file whose raw path still resolves).
    let read_result = match read_result {
        VersionRead::Ok(_) => read_result,
        other => merge_non_ok(other, read_disk_version(path)),
    };

    // The path that still exists on disk (canonical form preferred), for any
    // follow-up read (disk content / file identity).
    let live_path = canon.as_deref().filter(|c| c.exists()).unwrap_or(path);

    match read_result {
        VersionRead::PermissionDenied => {
            // §5.4: the file still exists but is now unreadable. Previously this
            // was silently skipped; now it surfaces as PermissionChanged so the
            // user can fix permissions or Save As.
            set_conflict(&tab, id, emitter, ConflictState::PermissionChanged, None);
            return;
        }
        VersionRead::Other(msg) => {
            // A genuinely transient error (not NotFound, not PermissionDenied).
            // Don't classify as anything — log and skip, as before.
            tracing::warn!("disk version read failed for {}: {msg}", live_path.display());
            return;
        }
        VersionRead::NotFound => {
            // NotFound on both candidate paths → the file is genuinely gone.
            if !path_exists(path) && canon.as_deref().is_none_or(|c| !c.exists()) {
                set_conflict(&tab, id, emitter, ConflictState::Missing, None);
                return;
            }
            // One path was NotFound but the other still exists → transient
            // (e.g. canonicalization race). Skip without classifying.
            return;
        }
        VersionRead::Ok(new_version) => {
            // Fall through to the content/identity comparison below.
            handle_version_change(&tab, id, live_path, new_version, emitter, vfs, workers);
        }
    }
}

/// Outcome of a single on-disk [`DiskVersion`] read, with the three §5.4
/// failure modes distinguished. `Other` carries the message (not the io::Error)
/// so the enum is [`Clone`] — needed when merging two candidate-path reads.
#[derive(Clone)]
enum VersionRead {
    Ok(DiskVersion),
    NotFound,
    PermissionDenied,
    Other(String),
}

/// Read a [`DiskVersion`] from `path`, classifying the io error per §5.4.
fn read_disk_version(path: &Path) -> VersionRead {
    match DiskVersion::from_path(path) {
        Ok(v) => VersionRead::Ok(v),
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => VersionRead::NotFound,
            std::io::ErrorKind::PermissionDenied => VersionRead::PermissionDenied,
            _ => VersionRead::Other(e.to_string()),
        },
    }
}

/// Merge two non-Ok [`VersionRead`]s from the canonical + raw candidate paths.
/// Preference order: `PermissionDenied` (the file exists but is unreadable — the
/// most actionable signal) beats `NotFound` beats `Other`. An `Ok` always wins
/// (the caller passes `other` only when the first read was non-Ok, but a `Ok`
/// fallback means the file is fine).
fn merge_non_ok(_first: VersionRead, fallback: VersionRead) -> VersionRead {
    match (&_first, &fallback) {
        (VersionRead::Ok(_), _) | (_, VersionRead::Ok(_)) => {
            // An Ok read always wins — the file is readable via at least one path.
            if matches!(_first, VersionRead::Ok(_)) {
                _first
            } else {
                fallback
            }
        }
        (VersionRead::PermissionDenied, _) | (_, VersionRead::PermissionDenied) => {
            VersionRead::PermissionDenied
        }
        (VersionRead::NotFound, _) | (_, VersionRead::NotFound) => VersionRead::NotFound,
        _ => _first,
    }
}

/// The content-and-identity comparison half of [`handle_external_change_locked`],
/// split out so the Ok(version) arm stays readable. Implements the §8.4 + §5.4
/// rules for a successfully-read new on-disk version:
/// - content identical + inode identical → no-op (self-save / touch).
/// - content identical + inode CHANGED → `Replaced` (dirty) or silent re-baseline (clean).
/// - content differs + dirty → `Modified` (carrying the new disk_version + disk content).
/// - content differs + clean → auto-reload.
fn handle_version_change(
    tab: &Arc<TabState>,
    id: DocumentId,
    live_path: &Path,
    new_version: DiskVersion,
    emitter: &Arc<dyn Emitter>,
    vfs: &Arc<MemoryVfs>,
    workers: &Workers,
) {
    // Snapshot stored version + inode + dirty under a brief lock.
    let (stored_version, stored_identity, dirty) = {
        let rt = tab.state.lock();
        (rt.disk_version, rt.file_identity, rt.meta.dirty)
    };

    let content_same = stored_version == Some(new_version);
    // The file's CURRENT inode — captured best-effort (UNKNOWN degrades the
    // Replaced check to "never fire" safely).
    let new_identity = FileIdentity::from_path(live_path);
    let identity_changed = stored_identity != FileIdentity::UNKNOWN
        && new_identity != FileIdentity::UNKNOWN
        && stored_identity != new_identity;

    // Case 1: content identical.
    if content_same {
        if identity_changed {
            // §5.4 Replaced: same bytes, new inode (e.g. `sed -i`, an atomic
            // write-then-rename from another tool). The buffer is byte-identical
            // to disk so there's nothing to merge — but we must re-baseline the
            // stored identity so the NEXT change detects correctly, and (per
            // §5.4) surface the replacement so the user knows an external tool
            // swapped their file. For a dirty buffer we mark it a conflict
            // (conservative: the user has unsaved edits and the file identity
            // changed under them). For a clean buffer we silently re-baseline
            // (the bytes match, so there's no user-visible loss).
            if dirty {
                set_conflict(
                    tab,
                    id,
                    emitter,
                    ConflictState::Replaced { identity_changed: true },
                    None,
                );
            } else {
                // Clean buffer: re-baseline the inode silently (bytes match, no
                // user-visible change) and update the stored version for parity.
                let mut rt = tab.state.lock();
                rt.disk_version = Some(new_version);
                rt.file_identity = new_identity;
            }
            return;
        }
        // Content identical AND inode identical (or inode unknown): a touch-only
        // change or the app's own save (whose version `mark_saved` just
        // recorded). No-op — no reload, no recompile.
        return;
    }

    // Case 2: content differs.
    if dirty {
        // Buffer has unsaved edits → never clobber. Surface Modified with the
        // disk content (for the compare view) AND the new disk_version (carried
        // Rust-side so re-detection / use-disk knows the target version).
        let disk_content = std::fs::read_to_string(live_path).ok();
        set_conflict(
            tab,
            id,
            emitter,
            ConflictState::Modified {
                disk_version: Some(new_version),
            },
            disk_content,
        );
        return;
    }

    // Clean buffer + external change → auto-reload. Read the new text, then
    // re-check `dirty` BEFORE committing the reload: the disk read above ran
    // outside any lock, and a `DocumentService::update_text` (the user's first
    // keystroke) could have landed in that window. Applying the reload
    // unconditionally would either overwrite that edit on the world buffer
    // (last `set_text` wins) or — worse — leave it in the buffer while marking
    // it clean (`dirty = false`), silently dropping it on close. Re-checking
    // `dirty` under the commit lock converts this into the Modified-conflict
    // path, which is the safe non-destructive branch.
    let Ok(content) = std::fs::read_to_string(live_path) else {
        // File vanished between the version read and the content read.
        set_conflict(tab, id, emitter, ConflictState::Missing, None);
        return;
    };
    // Commit text + metadata under the same state lock used by `update_text`.
    // Whichever side acquires it first creates one coherent snapshot:
    // - an editor update first makes the document dirty, routing us to conflict;
    // - a clean reload first completes atomically, after which the editor's
    //   versioned update safely replaces it and becomes dirty.
    let (revision, canon) = {
        let mut rt = tab.state.lock();
        if rt.meta.dirty {
            // An edit landed while the disk content was being read. Don't
            // clobber it; surface Modified with the disk bytes for comparison.
            drop(rt);
            set_conflict(
                tab,
                id,
                emitter,
                ConflictState::Modified {
                    disk_version: Some(new_version),
                },
                Some(content),
            );
            return;
        }
        tab.world.set_text(content.clone());
        rt.meta.revision = rt.meta.revision.saturating_add(1);
        rt.meta.dirty = false;
        rt.meta.conflict = ConflictState::None;
        rt.disk_version = Some(new_version);
        rt.file_identity = new_identity;
        (
            rt.meta.revision,
            rt.meta.origin.canonical_path().map(|p| p.to_path_buf()),
        )
    };
    // Keep the shared VFS in step with the reloaded buffer (§5 end): another
    // tab that #includes this file must compile against the reloaded content.
    if let Some(canon) = canon {
        vfs.upsert(canon, content, revision);
    }
    if let Some(worker) = workers.read().get(&id) {
        worker.recompile();
    }
}
