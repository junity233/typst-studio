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
    let reg = store.registry.read();
    reg.find_by_canonical(canon)
        .and_then(|id| reg.get(id).cloned())
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
    match watcher::watch(parent, on_change) {
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

use crate::domain::disk_version::DiskVersion;
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

    // Read the new on-disk version. Distinguish "file deleted" (NotFound) from
    // other read failures (permissions, transient IO): only the former is
    // Missing (§8.4); a transient error is logged and ignored so we don't
    // wrongly tell the user their file was deleted. Try the canonical path
    // first (it may still exist), then the raw event path.
    let new_version = canon
        .as_deref()
        .and_then(|c| match DiskVersion::from_path(c) {
            Ok(v) => Some(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                tracing::warn!("disk version read failed for {}: {e}", c.display());
                None
            }
        })
        .or_else(|| match DiskVersion::from_path(path) {
            Ok(v) => Some(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                tracing::warn!("disk version read failed for {}: {e}", path.display());
                None
            }
        });
    let new_version = match new_version {
        // NotFound on both candidate paths → the file is genuinely gone.
        None if !path_exists(path) && canon.as_deref().is_none_or(|c| !c.exists()) => {
            set_conflict(&tab, id, emitter, ConflictState::Missing, None);
            return;
        }
        // A transient read failure (not NotFound, or NotFound on one path but
        // the other still exists) → don't classify as Missing; skip this event.
        None => return,
        Some(v) => v,
    };
    // The path that still exists on disk (canonical form preferred).
    let live_path = canon.as_deref().filter(|c| c.exists()).unwrap_or(path);

    let (stored_version, dirty) = {
        let rt = tab.state.lock();
        (rt.disk_version.clone(), rt.meta.dirty)
    };

    // Content identical to the stored version (mtime-only change, §8.4 last
    // bullet, OR the app's own save whose version `mark_saved` just recorded):
    // no-op — no reload, no recompile.
    if stored_version.as_ref() == Some(&new_version) {
        return;
    }

    if dirty {
        // Buffer has unsaved edits → never clobber. Surface the conflict with
        // the disk content so the UI can offer compare / use-disk / overwrite.
        let disk_content = std::fs::read_to_string(live_path).ok();
        set_conflict(&tab, id, emitter, ConflictState::Modified, disk_content);
        return;
    }

    // Clean buffer + external change → auto-reload. Read the new text and
    // reload without marking dirty.
    let Ok(content) = std::fs::read_to_string(live_path) else {
        // File vanished between the version read and the content read.
        set_conflict(&tab, id, emitter, ConflictState::Missing, None);
        return;
    };
    tab.world.set_text(content.clone());
    let (revision, canon) = {
        let mut rt = tab.state.lock();
        rt.meta.revision = rt.meta.revision.saturating_add(1);
        rt.meta.dirty = false;
        rt.meta.conflict = ConflictState::None;
        rt.disk_version = Some(new_version);
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
