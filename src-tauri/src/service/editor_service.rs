//! `EditorService` — multi-tab orchestration owning one `EditorWorld` per tab.
//!
//! This is the core of the backend. It owns the [`tabs`](Self::tabs) map (an
//! `Arc<RwLock<HashMap>>` so debounced compile closures can capture clones of
//! just the shared state, avoiding a circular `Arc<EditorService>` reference),
//! a [`CompileScheduler`] for 300ms debounced compiles, and an [`Emitter`]
//! abstraction decoupling it from Tauri's `AppHandle`.
//!
//! ## Compile flow
//!
//! [`update_text`](Self::update_text) updates the world's source and schedules a
//! debounced compile. When the timer fires (or immediately via
//! [`compile_now`](Self::compile_now)), [`do_compile`](Self::do_compile):
//! 1. emits `status: compiling`,
//! 2. locks the tab and runs [`compile`](crate::typst_engine::compiler::compile),
//! 3. stores the outcome + document on the tab,
//! 4. on success renders SVG pages and emits `compiled` + `status: success`,
//!    on failure emits `diagnostics` + `status: error`.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use typst_layout::PagedDocument;

use crate::domain::compile_result::CompileOutcome;
use crate::domain::compile_status::CompileStatus;
use crate::domain::diagnostics::{Diagnostic, Range, Severity};
use crate::domain::disk_version::DiskVersion;
use crate::domain::document::{ConflictState, DocumentId, DocumentMeta, DocumentOrigin};
use crate::domain::path::canonicalize_for_identity;
use crate::domain::registry::{DocumentRegistry, SharedRegistry};
use crate::domain::source_map::LineRect;
use crate::error::{AppError, Result};
use crate::fs::watcher;
use crate::render::pipeline::RenderPipeline;
use crate::render::source_map::build_source_map;
use crate::render::svg::SvgRenderer;
use crate::typst_engine::compiler;
use crate::typst_engine::world::EditorWorld;

use super::compile_worker::CompileWorker;
use super::tab_state::TabState;
use super::workspace_service::WorkspaceService;

/// Default content for a fresh untitled tab.
const DEFAULT_TEMPLATE: &str = "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

/// Shared tab map. The world is NOT behind a per-tab Mutex (it has its own
/// interior `RwLock<Source>`), so compile can proceed without holding any
/// tab-level lock — eliminating contention between typing and compiling.
type Tabs = Arc<RwLock<HashMap<DocumentId, Arc<TabState>>>>;
/// Per-tab compile workers (one long-lived thread each).
type Workers = Arc<RwLock<HashMap<DocumentId, CompileWorker>>>;
/// Cache of [`FileResolver`]s for loose files, keyed by parent directory.
/// Files in the same directory share one resolver so same-dir `#include` /
/// `#image()` resolve consistently (§4.2 LooseFile). `FileResolver` is cheap to
/// clone (root behind an `Arc<RwLock<PathBuf>>`), so a clone is handed to each
/// tab's [`EditorWorld`](crate::typst_engine::world::EditorWorld).
type LooseResolvers = Arc<RwLock<HashMap<PathBuf, crate::fs::FileResolver>>>;

/// Per-parent-directory filesystem watchers for loose files OUTSIDE the active
/// workspace (§4.2 / §8.4). The workspace's own watcher covers in-workspace
/// files, so this cache only ever holds parents that are NOT inside the
/// workspace root. Same-dir loose files share one watcher (keyed by parent),
/// mirroring the [`loose_resolvers`](EditorService::loose_resolvers) cache.
///
/// Bounded by the number of distinct out-of-workspace directories the user has
/// opened — not unbounded. Watchers are left alive on tab close for B2 (small
/// per-directory cost); see the TODO on [`close_tab`](EditorService::close_tab).
type LooseWatchers = Arc<RwLock<HashMap<PathBuf, watcher::WatcherGuard>>>;

/// Decouples `EditorService` from the concrete event-delivery mechanism.
///
/// In production this is backed by a Tauri `AppHandle`
/// ([`crate::ipc::state::TauriEmitter`]); in tests by a `CapturingEmitter` that
/// records emits for assertion.
///
/// Every emit carries a `revision` (§7): the document revision the result
/// corresponds to. Stale-revision results are discarded by the frontend.
pub trait Emitter: Send + Sync {
    /// Notify the frontend of a successful compile with rendered SVG pages and
    /// the source map (source line → preview-page bbox).
    fn emit_compiled(
        &self,
        id: DocumentId,
        revision: u64,
        pages: Vec<String>,
        line_map: Vec<LineRect>,
        duration_ms: u64,
    );
    /// Notify the frontend of compile errors.
    fn emit_diagnostics(&self, id: DocumentId, revision: u64, diagnostics: Vec<Diagnostic>);
    /// Notify the frontend of a compile status transition.
    fn emit_status(
        &self,
        id: DocumentId,
        revision: u64,
        status: CompileStatus,
        duration_ms: Option<u64>,
    );
    /// Notify the frontend of an external-modification conflict (§8.4). Emits
    /// the disk content (for `Modified`, so the UI can show a diff) and the
    /// new conflict state. `revision` tags the buffer revision.
    fn emit_conflict(
        &self,
        id: DocumentId,
        revision: u64,
        conflict: ConflictState,
        disk_content: Option<String>,
    );
}

/// The multi-tab editor orchestrator.
pub struct EditorService {
    tabs: Tabs,
    workers: Workers,
    registry: SharedRegistry,
    /// Parent-directory-rooted resolvers for loose files (§4.2). Shared so two
    /// tabs whose files live in the same directory anchor against one root.
    loose_resolvers: LooseResolvers,
    /// Per-parent-dir watchers for out-of-workspace loose files (§4.2 / §8.4).
    /// In-workspace files are covered by the workspace watcher; this cache
    /// closes the gap for files opened outside the workspace root.
    loose_watchers: LooseWatchers,
    emitter: Arc<dyn Emitter>,
}

impl EditorService {
    /// Construct a new service with the given emitter.
    pub fn new(emitter: Arc<dyn Emitter>) -> Self {
        Self {
            tabs: Arc::new(RwLock::new(HashMap::new())),
            workers: Arc::new(RwLock::new(HashMap::new())),
            registry: Arc::new(RwLock::new(DocumentRegistry::new())),
            loose_resolvers: Arc::new(RwLock::new(HashMap::new())),
            loose_watchers: Arc::new(RwLock::new(HashMap::new())),
            emitter,
        }
    }

    /// Read-only access to the document registry (for the IPC layer to detect
    /// "already open" before creating a duplicate).
    pub fn registry(&self) -> &SharedRegistry {
        &self.registry
    }

    /// Create a new untitled tab and start its compile worker. Returns
    /// immediately; the initial compile runs on the worker thread.
    pub fn new_tab(&self, content: Option<String>) -> DocumentMeta {
        let text = content.unwrap_or_else(|| DEFAULT_TEMPLATE.to_string());
        let meta = DocumentMeta::new_untitled();
        let id = meta.id;
        // Untitled docs carry no canonical path, so the registry never rejects
        // them (multiple untitleds coexist).
        self.registry
            .write()
            .register(meta.clone())
            .expect("untitled registration cannot conflict");
        let tab = Arc::new(TabState::with_meta(meta.clone(), text));
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        meta
    }

    /// Open a tab from already-read content (the command layer handles IO).
    /// Sets the path + title from `path`. A worker is started for the tab.
    ///
    /// `workspace` supplies the active-workspace context for origin
    /// classification (§4.2): when a workspace is open and the file lives
    /// inside it, the tab is a `WorkspaceFile` backed by the workspace
    /// resolver; otherwise it is a `LooseFile` rooted at its parent dir. Pass
    /// `None` when no workspace context is available (the file is always loose
    /// then).
    ///
    /// If a document at `path`'s canonical location is already open, **no new
    /// document is created**: the existing [`DocumentId`] is returned so the
    /// caller can focus its view instead (§4.1 uniqueness, §8.1 step 3).
    pub fn open_from_content(
        &self,
        path: PathBuf,
        content: String,
        workspace: Option<&WorkspaceService>,
    ) -> Result<DocumentMeta> {
        let canon = canonicalize_for_identity(&path)?;
        if let Some(existing) = self.find_existing(&canon) {
            return Ok(existing);
        }
        let meta = self.classify_new(DocumentId::new(), canon.clone(), workspace);
        let id = meta.id;
        self.registry.write().register(meta.clone())?;
        let tab = self.tab_from_meta(&meta, &content, workspace);
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        // Seed the on-disk version (§8.4) and ensure a watcher covers this
        // file's directory (the workspace watcher for in-workspace files, a
        // parent-dir watcher for out-of-workspace loose files).
        self.set_disk_version_from_path(id, meta.origin.canonical_path());
        self.ensure_dir_watched(id, &meta.origin, workspace);
        Ok(meta)
    }

    /// Open a tab backed by a real file on disk. The world's resolver is
    /// derived from the document's origin (§4.2): a workspace file (inside the
    /// active workspace, when `workspace` is supplied) gets the workspace
    /// resolver; a loose file gets a parent-directory-rooted [`FileResolver`]
    /// so same-dir `#include` / `#image()` resolve. Falls back to a detached
    /// world if the resolver can't anchor the path.
    ///
    /// Deduplicates by canonical path like
    /// [`open_from_content`](Self::open_from_content).
    pub fn open_from_disk(
        &self,
        path: PathBuf,
        content: String,
        workspace: Option<&WorkspaceService>,
    ) -> Result<DocumentMeta> {
        let canon = canonicalize_for_identity(&path)?;
        if let Some(existing) = self.find_existing(&canon) {
            return Ok(existing);
        }
        let meta = self.classify_new(DocumentId::new(), canon.clone(), workspace);
        let id = meta.id;
        self.registry.write().register(meta.clone())?;
        let tab = self.tab_from_meta(&meta, &content, workspace);
        self.tabs.write().insert(id, tab.clone());
        self.create_worker(id, tab);
        // Seed the on-disk version (§8.4) and ensure a watcher covers this
        // file's directory (the workspace watcher for in-workspace files, a
        // parent-dir watcher for out-of-workspace loose files).
        self.set_disk_version_from_path(id, meta.origin.canonical_path());
        self.ensure_dir_watched(id, &meta.origin, workspace);
        Ok(meta)
    }

    /// Build the initial [`TabState`] for a freshly-classified `meta`, picking
    /// the resolver that matches the origin: the workspace resolver for a
    /// `WorkspaceFile`, the cached parent resolver for a `LooseFile`, and a
    /// detached world for `Untitled`. Shared by the two open paths.
    fn tab_from_meta(
        &self,
        meta: &DocumentMeta,
        content: &str,
        workspace: Option<&WorkspaceService>,
    ) -> Arc<TabState> {
        let canon = match meta.origin.canonical_path() {
            Some(p) => p,
            None => return Arc::new(TabState::with_meta(meta.clone(), content.to_string())),
        };
        match &meta.origin {
            DocumentOrigin::WorkspaceFile { .. } => {
                // Origin is a workspace file iff the workspace was open and
                // contained the path at classify time, so the resolver is
                // available. Guard against the (impossible-in-practice) race
                // where the workspace closed between classify and here by
                // falling back to a detached single-file world (no relative
                // resolution) — the next reclassify pass on a real open will
                // restore the workspace resolver.
                let resolver = workspace.and_then(|ws| ws.resolver());
                self.build_tab(meta, content, resolver, canon)
            }
            DocumentOrigin::LooseFile { root, .. } => {
                self.build_loose_tab(meta, content, root, canon)
            }
            DocumentOrigin::Untitled => {
                Arc::new(TabState::with_meta(meta.clone(), content.to_string()))
            }
        }
    }

    /// Look up (or insert) the shared [`FileResolver`] for a loose-file parent
    /// directory, and return a cheap clone (§4.2). Two loose files in the same
    /// directory share one resolver so their relative-include resolution is
    /// consistent and the cache stays small.
    fn loose_resolver_for(&self, parent: &std::path::Path) -> crate::fs::FileResolver {
        if let Some(r) = self.loose_resolvers.read().get(parent) {
            return r.clone();
        }
        let resolver = crate::fs::FileResolver::new(parent.to_path_buf());
        // Another thread may have inserted concurrently; the last writer wins,
        // but both resolvers anchor the same root, so it's harmless.
        self.loose_resolvers
            .write()
            .entry(parent.to_path_buf())
            .or_insert(resolver)
            .clone()
    }

    // --- external-modification support (§8.4) --------------------------------

    /// Look up (or insert) the parent-directory watcher for a loose file
    /// outside the active workspace (§4.2 / §8.4). Same-dir loose files share
    /// one watcher. The watcher's `on_change` routes changed paths into
    /// [`handle_external_change`](Self::handle_external_change) (it does NOT
    /// emit `fs_changed` — that event is workspace-tree-only, and these dirs
    /// are by definition outside the workspace). Best-effort: a watcher failure
    /// is logged and skipped (the cache entry is simply not inserted).
    fn loose_watcher_for(&self, parent: &std::path::Path) {
        if self.loose_watchers.read().contains_key(parent) {
            return;
        }
        // The callback only needs `self` to route into handle_external_change.
        // It captures the shared tab map + emitter + registry by cloning the
        // Arcs (NOT an Arc<EditorService> — that would be a cycle), so the
        // closure stays 'static + Send + Sync.
        let tabs = self.tabs.clone();
        let workers = self.workers.clone();
        let registry = self.registry.clone();
        let emitter = self.emitter.clone();
        let on_change: watcher::OnChange = Arc::new(move |paths: &[PathBuf]| {
            for p in paths {
                handle_external_change_locked(p, &tabs, &registry, &workers, &emitter);
            }
        });
        match watcher::watch(parent, on_change) {
            Ok(guard) => {
                self.loose_watchers
                    .write()
                    .entry(parent.to_path_buf())
                    .or_insert(guard);
            }
            // A watcher failure is non-fatal — the file still edits, just
            // without live external-change detection. Log and continue.
            Err(e) => tracing::warn!("could not start loose-file watcher for {parent:?}: {e}"),
        }
    }

    /// Seed (or refresh) a tab's [`DiskVersion`] from its on-disk file (§8.4).
    /// Best-effort: if the file can't be read (untitled / deleted mid-open), the
    /// version is left as-is. Called on open and after Save As rebind.
    fn set_disk_version_from_path(&self, id: DocumentId, path: Option<&Path>) {
        let Some(path) = path else { return };
        let Ok(version) = DiskVersion::from_path(path) else {
            return;
        };
        if let Some(t) = self.tabs.read().get(&id) {
            t.state.lock().disk_version = Some(version);
        }
    }

    /// Ensure the directory of a freshly-opened file is watched for external
    /// changes. In-workspace files are covered by the workspace watcher; only
    /// OUT-of-workspace loose files need a parent-dir watcher here.
    fn ensure_dir_watched(
        &self,
        _id: DocumentId,
        origin: &DocumentOrigin,
        workspace: Option<&WorkspaceService>,
    ) {
        let DocumentOrigin::LooseFile { root, path, .. } = origin else {
            return;
        };
        // Skip if the file is actually inside the open workspace — that dir is
        // already watched by the workspace watcher, and double-watching wastes
        // a platform file watch handle.
        let inside_workspace = workspace
            .filter(|ws| ws.is_open())
            .is_some_and(|ws| ws.contains(path) || ws.contains(root));
        if !inside_workspace {
            self.loose_watcher_for(root);
        }
    }

    /// Mark a tab as saved: clear the dirty flag AND recompute + store the
    /// on-disk [`DiskVersion`] from the freshly-written file (§8.2 / §8.4).
    ///
    /// This MUST be called **after** the IPC layer's `std::fs::write` returns,
    /// so the stored version matches the bytes on disk. Then, when the watcher
    /// fires for the file we just wrote, [`handle_external_change`] sees the
    /// new disk version equals the stored one and treats the event as
    /// self-induced (no reload, no conflict). Replaces the old
    /// [`clear_dirty`](Self::clear_dirty) in the save path.
    pub fn mark_saved(&self, id: DocumentId) {
        let path = {
            let tabs = self.tabs.read();
            let Some(tab) = tabs.get(&id) else { return };
            let mut rt = tab.state.lock();
            rt.meta.dirty = false;
            rt.meta.conflict = ConflictState::None;
            rt.meta.origin.canonical_path().map(|p| p.to_path_buf())
        };
        // Recompute the disk version from the on-disk bytes the caller just
        // wrote. Reads outside the lock (no nested cross-service locks).
        if let Some(path) = path {
            self.set_disk_version_from_path(id, Some(&path));
        }
    }

    /// Handle an external disk change to a path, routing it to the open
    /// document (if any) whose canonical path matches (§8.4). Called from the
    /// workspace watcher's and the loose-file watchers' `on_change` callbacks
    /// (on the watcher flush thread); safe to call concurrently with compile
    /// workers and `update_text` — it mirrors the existing brief-lock pattern.
    ///
    /// Rules (§8.4):
    /// - **no open document** at `path` → no-op (the frontend's tree refresh
    ///   handles non-document files).
    /// - **file now missing on disk** → `ConflictState::Missing`; buffer
    ///   preserved; conflict event emitted; no reload.
    /// - **content identical** to the stored version (mtime-only change) →
    ///   no-op (no reload, no recompile).
    /// - **content differs AND buffer clean** → auto-reload: set world text,
    ///   bump revision, keep `dirty=false`, update disk version, recompile.
    /// - **content differs AND buffer dirty** → `ConflictState::Modified`;
    ///   buffer untouched; conflict event emitted with the disk content.
    ///
    /// The app's OWN save is recognized because [`mark_saved`] updates the
    /// stored version to match the freshly-written bytes, so the watcher event
    /// for that write compares equal → no-op (the "content identical" case).
    pub fn handle_external_change(&self, path: &Path) {
        handle_external_change_locked(
            path,
            &self.tabs,
            &self.registry,
            &self.workers,
            &self.emitter,
        );
    }

    /// Build a [`TabState`] for `meta` seeded with `text`, anchoring the world
    /// at `canon` against the supplied resolver.
    ///
    /// - `Some(resolver)`: the world's main `FileId` is derived from `canon`
    ///   via the resolver, so `#include` / `#image()` resolve relative to the
    ///   main file's directory (and any sibling under the resolver's root). Use
    ///   this for both workspace files (workspace resolver) and loose files
    ///   (parent-directory resolver).
    /// - `None`: a detached single-file world — no `#include` resolution. Used
    ///   for untitled tabs and as a fallback when the resolver can't anchor
    ///   `canon` (e.g. the root vanished mid-flight).
    ///
    /// Shared by [`open_from_disk`](Self::open_from_disk),
    /// [`rebind_path`](Self::rebind_path), and
    /// [`reclassify_documents`](Self::reclassify_documents) so all three
    /// reconstruct the world identically.
    fn build_tab(
        &self,
        meta: &DocumentMeta,
        text: &str,
        resolver: Option<crate::fs::FileResolver>,
        canon: &Path,
    ) -> Arc<TabState> {
        match resolver {
            Some(r) => match EditorWorld::with_resolver(
                text.to_string(),
                crate::typst_engine::font_loader::SystemFontLoader::new(),
                r,
                canon,
            ) {
                Ok(world) => Arc::new(TabState::with_meta_and_world(meta.clone(), world)),
                // Resolver couldn't anchor the path — degrade to detached.
                Err(_) => Arc::new(TabState::with_meta(meta.clone(), text.to_string())),
            },
            None => Arc::new(TabState::with_meta(meta.clone(), text.to_string())),
        }
    }

    /// Build a [`TabState`] whose world is a loose file anchored at `root`,
    /// seeded with `text`. Falls back to a detached single-file world if the
    /// resolver can't anchor `canon` (e.g. the root has vanished). Thin wrapper
    /// over [`build_tab`](Self::build_tab) using the cached parent resolver.
    fn build_loose_tab(
        &self,
        meta: &DocumentMeta,
        text: &str,
        root: &Path,
        canon: &Path,
    ) -> Arc<TabState> {
        let resolver = self.loose_resolver_for(root);
        self.build_tab(meta, text, Some(resolver), canon)
    }

    /// Return the existing metadata for an already-open canonical path, if any.
    /// Used by the open path to deduplicate before creating a new document.
    fn find_existing(&self, canon: &std::path::Path) -> Option<DocumentMeta> {
        let reg = self.registry.read();
        reg.find_by_canonical(canon)
            .and_then(|id| reg.get(id).cloned())
    }

    /// Classify a fresh on-disk path as `WorkspaceFile` or `LooseFile` (§4.2).
    /// When `workspace` is open and contains `canon`, the file is a
    /// `WorkspaceFile` carrying the workspace's id; otherwise it is a
    /// `LooseFile` rooted at its parent directory.
    fn classify_new(
        &self,
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

    /// Full Save As rebind (§4.1 / §8.3): give a tab a new on-disk path while
    /// preserving its [`DocumentId`], buffer, and revision.
    ///
    /// Unlike the Phase 1 [`assign_path`](Self::assign_path) (which only updated
    /// metadata), this **rebuilds the [`EditorWorld`]** with a resolver anchored
    /// at the new parent directory, then restarts the compile worker so the new
    /// root's `#include` / `#image()` resolution takes effect. comemo's
    /// incremental cache is discarded in the process — acceptable on Save As.
    ///
    /// Steps:
    /// 1. Canonicalize the target (it exists on disk — the caller wrote it).
    /// 2. Snapshot the current buffer + revision under lock.
    /// 3. Build new metadata: `LooseFile` rooted at the target's parent, clean,
    ///    revision carried over from the old meta.
    /// 4. Rebind the registry (drops the old canonical slot, claims the new
    ///    one) — fails fast with [`AppError::AlreadyOpen`] if the target path is
    ///    already bound to a different document, leaving the tab untouched.
    /// 5. Build a new [`TabState`] (world + runtime), preserving the buffer +
    ///    revision; reset the compile result so the next compile is authoritative.
    /// 6. Swap the tab in, drop the old worker, and spawn a fresh one that
    ///    signals an immediate recompile.
    ///
    /// Task A always reclassifies as `LooseFile`; Task B will pick
    /// `WorkspaceFile` when the target is inside the active workspace.
    pub fn rebind_path(&self, id: DocumentId, target_path: PathBuf) -> Result<()> {
        let canon = canonicalize_for_identity(&target_path)?;
        let root = canon
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // Snapshot the current buffer + revision before mutating anything, so a
        // registry conflict leaves the tab fully intact.
        let (text, revision) = {
            let tabs = self.tabs.read();
            let tab = tabs
                .get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?;
            let rt = tab.state.lock();
            (tab.world.text(), rt.meta.revision)
        };

        // New metadata: loose file at the target, clean, revision carried over.
        let new_meta = DocumentMeta {
            dirty: false,
            revision,
            ..DocumentMeta::with_loose_path(id, canon.clone(), root.clone())
        };

        // Rebind the registry first — on conflict, nothing below runs.
        self.registry.write().rebind(id, new_meta.clone())?;

        // Rebuild the world against the new parent directory. `build_loose_tab`
        // carries the meta (incl. revision) and resets the compile result via
        // `with_meta_and_world`; falls back to a detached world on anchor failure.
        let new_tab = self.build_loose_tab(&new_meta, &text, &root, &canon);

        // Swap the new world in and rotate the worker to trigger a recompile.
        self.swap_world(id, new_tab);

        // The rebuilt tab's runtime starts with `disk_version: None`. Seed it
        // from the freshly-written target file (Save As just wrote it), so the
        // imminent watcher event for that write is recognized as self-induced
        // (§8.2). Also ensure the target's parent dir is watched — Save As to a
        // directory outside the workspace needs a loose watcher to catch
        // future external changes (§4.2).
        self.set_disk_version_from_path(id, Some(&canon));
        self.loose_watcher_for(&root);
        Ok(())
    }

    /// Swap a freshly-built [`TabState`] in for `id`, dropping the old worker
    /// and spawning a fresh one that signals an immediate recompile.
    ///
    /// This is the shared "world rebuilt → worker rotated" tail used by both
    /// [`rebind_path`](Self::rebind_path) and
    /// [`reclassify_documents`](Self::reclassify_documents). Dropping the old
    /// worker discards comemo's incremental cache for the old world (acceptable
    /// on a Save As or a resolution-scope change); the new worker compiles
    /// against the rebuilt world.
    ///
    /// Callers MUST have already updated the registry (if the canonical path
    /// changed) and built `new_tab` preserving the buffer + revision.
    fn swap_world(&self, id: DocumentId, new_tab: Arc<TabState>) {
        self.tabs.write().insert(id, new_tab.clone());
        // There's a sub-millisecond window between dropping the old worker and
        // spawning the new one where an update_text could arrive and find no
        // worker (its recompile signal is dropped). Acceptable since both
        // callers (Save As, reclassify) are user-initiated and the buffer is
        // already captured in the new world.
        let _ = self.workers.write().remove(&id);
        self.create_worker(id, new_tab);
    }

    /// Deprecated alias — delegates to [`rebind_path`](Self::rebind_path). Kept
    /// temporarily for source compatibility during the migration; new callers
    /// should call `rebind_path` directly.
    #[deprecated(note = "use rebind_path — it rebuilds the world and recompiles")]
    pub fn assign_path(&self, id: DocumentId, path: PathBuf) -> Result<()> {
        self.rebind_path(id, path)
    }

    /// Reclassify every open document's [`DocumentOrigin`] against the current
    /// workspace state (§4.3), rebuilding each affected tab's world with the
    /// matching resolver. Called by the IPC command layer after a workspace
    /// opens or closes.
    ///
    /// Transitions (the file path itself never moves — only the classification
    /// and its resolution scope change):
    /// - **Workspace opens**: a `LooseFile` whose canonical path is inside the
    ///   new root becomes a `WorkspaceFile` (resolver switches to the workspace
    ///   root). A `WorkspaceFile` left over from a *prior* workspace is
    ///   re-claimed by the current workspace if still contained, else demoted
    ///   to `LooseFile`.
    /// - **Workspace closes**: every `WorkspaceFile` becomes a `LooseFile`
    ///   rooted at its parent dir (resolver switches to the parent-rooted one,
    ///   so same-dir `#include` still resolves).
    /// - `Untitled` documents are never touched.
    ///
    /// `DocumentId`, buffer text, `revision`, and `dirty` are preserved across
    /// every transition; compile results reset (the rebuilt world recompiles).
    pub fn reclassify_documents(&self, ws: &WorkspaceService) {
        // Snapshot the ids first so we release the read lock before mutating.
        let ids: Vec<DocumentId> = self.tabs.read().keys().copied().collect();
        for id in ids {
            self.reclassify_one(id, ws);
        }
    }

    /// Reclassify a single document, if its origin should change under `ws`.
    /// No-op when the origin is already correct (or the doc is untitled).
    fn reclassify_one(&self, id: DocumentId, ws: &WorkspaceService) {
        // Snapshot the current meta, buffer, revision, and disk_version under a
        // brief lock. disk_version is preserved across reclassification (the
        // file didn't change — only its resolution scope did), so it must be
        // carried over the world rebuild (which resets it to None).
        let (meta, text, disk_version) = {
            let tabs = self.tabs.read();
            let Some(tab) = tabs.get(&id).cloned() else {
                return;
            };
            let rt = tab.state.lock();
            (rt.meta.clone(), tab.world.text(), rt.disk_version.clone())
        };

        // Untitled docs are never reclassified.
        let Some(canon) = meta.origin.canonical_path().map(|p| p.to_path_buf()) else {
            return;
        };

        let Some(new_origin) = reclassified_origin(&meta.origin, &canon, ws) else {
            return; // already correct — no transition needed.
        };

        // Build the new meta preserving id, title, dirty, and revision. Only
        // the origin classification (and thus the resolution scope) changes;
        // the canonical path is identical, so the registry rebind is
        // idempotent for this id.
        let new_meta = DocumentMeta {
            origin: new_origin.clone(),
            ..meta
        };

        // Pick the resolver matching the new origin: workspace resolver for a
        // WorkspaceFile, cached parent resolver for a LooseFile.
        let resolver = resolver_for_origin(&new_meta.origin, ws, |parent| {
            self.loose_resolver_for(parent)
        });

        // Update the registry first (idempotent rebind — same canonical path).
        // A conflict here would be a bug (the path didn't move), but rebind is
        // fallible so honour the Result: on the impossible conflict, leave the
        // tab untouched rather than half-swap.
        if self.registry.write().rebind(id, new_meta.clone()).is_err() {
            return;
        }

        let new_tab = self.build_tab(&new_meta, &text, resolver, &canon);
        self.swap_world(id, new_tab);

        // Restore the disk_version (the rebuild reset it to None). The file is
        // unchanged, so the pre-transition snapshot is still accurate.
        if let Some(dv) = disk_version {
            if let Some(t) = self.tabs.read().get(&id) {
                t.state.lock().disk_version = Some(dv);
            }
        }

        // If the document is now a LooseFile outside the workspace, make sure
        // its parent dir is watched for external changes (§4.2). In-workspace
        // files are covered by the workspace watcher.
        if let DocumentOrigin::LooseFile { root, path, .. } = &new_origin {
            let inside = ws.is_open() && (ws.contains(path) || ws.contains(root));
            if !inside {
                self.loose_watcher_for(root);
            }
        }
    }

    /// Spawn a [`CompileWorker`] for `id` whose closure compiles `tab` and
    /// emits results. Signals an initial compile immediately.
    fn create_worker(&self, id: DocumentId, tab: Arc<TabState>) {
        let emitter = self.emitter.clone();
        let compile_fn: Arc<dyn Fn() + Send + Sync> =
            Arc::new(move || Self::do_compile_for_tab(&tab, &emitter, id));
        let worker = CompileWorker::spawn(compile_fn);
        worker.recompile(); // initial compile
        self.workers.write().insert(id, worker);
    }

    /// Close a tab, releasing its world and compile worker. The worker thread
    /// finishes its current compile (if any) then exits in the background —
    /// this method returns immediately.
    ///
    /// **Loose-file watchers are intentionally left running** for B2 (§8.4):
    /// evicting on close would require ref-counting same-dir loose files, and
    /// the per-directory cost is small. The cache is keyed by parent dir, so it
    /// is bounded by the number of distinct dirs opened — never unbounded.
    /// TODO(future): evict a loose watcher when the last same-dir loose file
    /// closes, to free the platform file-watch handle.
    pub fn close_tab(&self, id: DocumentId) -> Result<()> {
        // Drop the worker first (sends Shutdown, doesn't join).
        let _ = self.workers.write().remove(&id);
        let removed = self.tabs.write().remove(&id);
        if removed.is_none() {
            return Err(AppError::NotFound(format!("tab {id} not found")));
        }
        // Release the canonical-path slot so the file can be reopened.
        self.registry.write().unregister(id);
        Ok(())
    }

    /// Update a tab's source text and signal its worker to recompile. Returns
    /// instantly — `set_text` writes directly to the world's interior RwLock,
    /// and `recompile` is a non-blocking channel send.
    ///
    /// Bumps the document `revision` atomically with the dirty flag (§7), so
    /// every emitted compile/diagnostic/status event can carry the revision it
    /// corresponds to and stale results can be discarded.
    pub fn update_text(&self, id: DocumentId, content: String) -> Result<()> {
        let tab = {
            let tabs = self.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        tab.world.set_text(content);
        // Atomically bump revision + set dirty under one lock.
        let mut rt = tab.state.lock();
        rt.meta.revision = rt.meta.revision.saturating_add(1);
        let revision = rt.meta.revision;
        rt.meta.dirty = true;
        drop(rt);
        // Signal the worker. If it's busy compiling, the message queues; the
        // worker picks up the latest text when it finishes.
        if let Some(worker) = self.workers.read().get(&id) {
            worker.recompile();
        }
        let _ = revision; // captured by `do_compile_for_tab` via the world read
        Ok(())
    }

    /// Prepare data needed to save a tab: returns `(path, current_text)`. The
    /// command layer does the actual disk write (async). Errors if the tab is
    /// untitled (no path) or missing.
    pub fn prepare_save(&self, id: DocumentId) -> Result<(PathBuf, String)> {
        let tab = {
            let tabs = self.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        let path = tab
            .state
            .lock()
            .meta
            .path
            .clone()
            .ok_or_else(|| AppError::InvalidInput("tab has no on-disk path".into()))?;
        Ok((path, tab.world.text()))
    }

    /// Clear the dirty flag after a successful save.
    pub fn clear_dirty(&self, id: DocumentId) {
        if let Some(t) = self.tabs.read().get(&id) {
            t.state.lock().meta.dirty = false;
        }
    }

    /// Compile a tab synchronously (bypassing the worker). Used in tests.
    pub fn compile_now(&self, id: DocumentId) {
        if let Some(tab) = self.tabs.read().get(&id).cloned() {
            Self::do_compile_for_tab(&tab, &self.emitter, id);
        }
    }

    /// The shared compile pipeline: status → compile (no lock, panic-safe) →
    /// conditionally render → emit.
    ///
    /// **Compile/render separation**: diagnostics are emitted on every compile
    /// (fast feedback), but SVG rendering is **skipped** if the source text
    /// changed during compile (user kept typing). This avoids wasting 1–20 ms
    /// per page on intermediate previews that would be immediately superseded.
    /// The worker model guarantees that after a skipped render, the latest text
    /// is compiled immediately (no debounce delay).
    ///
    /// **Revision tagging (§7)**: the revision is snapshot *before* compile and
    /// stamped onto every emitted event. If the buffer changed mid-compile, the
    /// emitted revision will be the *older* one — the frontend discards it
    /// because a newer revision already won. This replaces relying on event
    /// arrival order for consistency.
    ///
    /// Runs inside [`std::panic::catch_unwind`] because the compile executes on
    /// the worker's large-stack thread — without catching, a typst panic would
    /// silently kill the thread and the frontend would see `compiling` forever.
    fn do_compile_for_tab(tab: &Arc<TabState>, emitter: &Arc<dyn Emitter>, id: DocumentId) {
        // Snapshot revision + text before compile. The revision is the
        // authoritative "this compile corresponds to" stamp.
        let (revision, text_before) = {
            let rt = tab.state.lock();
            (rt.meta.revision, tab.world.text())
        };
        emitter.emit_status(id, revision, CompileStatus::Compiling, None);

        // Compile WITHOUT holding any tab-level lock.
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            compiler::compile(&tab.world)
        }));

        let (outcome, doc) = match result {
            Ok(pair) => pair,
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>().cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown compiler panic".to_string());
                let diag = Diagnostic {
                    severity: Severity::Error,
                    range: Range {
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: 1,
                    },
                    message: format!("Internal compiler error: {msg}"),
                    code: None,
                };
                {
                    let mut rt = tab.state.lock();
                    rt.last_outcome = CompileOutcome::fail(vec![diag.clone()], 0);
                    rt.last_doc = None;
                    rt.last_compiled_revision = Some(revision);
                }
                emitter.emit_diagnostics(id, revision, vec![diag]);
                emitter.emit_status(id, revision, CompileStatus::Error, Some(0));
                return;
            }
        };

        // Store results under a brief lock.
        {
            let mut rt = tab.state.lock();
            rt.last_outcome = outcome.clone();
            rt.last_doc = doc.clone();
            rt.last_compiled_revision = Some(revision);
        }

        if outcome.success {
            // Always emit (possibly empty) diagnostics so the frontend clears
            // stale error markers from a previous failed compile.
            emitter.emit_diagnostics(id, revision, outcome.errors.clone());

            // Only render SVG if the text didn't change during compile.
            let text_after = tab.world.text();
            if text_before == text_after {
                if let Some(doc) = doc {
                    let pages = SvgRenderer::new().render(&doc);
                    // Build the source map from the same compiled document. This
                    // is cheap (one frame walk, KB-scale output) and runs on the
                    // compile thread, so it never blocks the editor. Skipped
                    // alongside SVG when the user kept typing — staying in lock
                    // step with the rendered pages.
                    let line_map = build_source_map(&doc, &tab.world);
                    emitter.emit_compiled(id, revision, pages, line_map, outcome.duration_ms);
                }
            }
            emitter.emit_status(id, revision, CompileStatus::Success, Some(outcome.duration_ms));
        } else {
            emitter.emit_diagnostics(id, revision, outcome.errors.clone());
            emitter.emit_status(id, revision, CompileStatus::Error, Some(outcome.duration_ms));
        }
    }

    // --- accessors -----------------------------------------------------------

    /// Current diagnostics for a tab (empty if the tab or last outcome has none).
    pub fn get_diagnostics(&self, id: DocumentId) -> Vec<Diagnostic> {
        self.tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().last_outcome.errors.clone())
            .unwrap_or_default()
    }

    /// The last successfully compiled document for a tab (for export).
    pub fn last_doc(&self, id: DocumentId) -> Option<PagedDocument> {
        self.tabs
            .read()
            .get(&id)
            .and_then(|t| t.state.lock().last_doc.clone())
    }

    /// Metadata for a single tab, if present.
    pub fn tab_meta(&self, id: DocumentId) -> Option<DocumentMeta> {
        self.tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().meta.clone())
    }

    /// The current content revision for a tab (§7). Bumped on every
    /// [`update_text`](Self::update_text). `None` if the tab is not open.
    pub fn tab_revision(&self, id: DocumentId) -> Option<u64> {
        self.tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().meta.revision)
    }

    /// Metadata for all open tabs (for a tab-list / sidebar).
    pub fn list_tabs(&self) -> Vec<DocumentMeta> {
        self.tabs
            .read()
            .values()
            .map(|t| t.state.lock().meta.clone())
            .collect()
    }

    /// Current source text of a tab (the in-memory buffer, possibly dirty).
    pub fn tab_text(&self, id: DocumentId) -> Option<String> {
        self.tabs.read().get(&id).map(|t| t.world.text())
    }

    /// Number of parent directories currently cached in the loose-resolver map.
    /// Test-only accessor for asserting cache sharing (§4.2).
    #[cfg(test)]
    pub fn loose_resolver_cache_len(&self) -> usize {
        self.loose_resolvers.read().len()
    }

    /// Number of out-of-workspace parent dirs currently watched by loose-file
    /// watchers. Test-only accessor for asserting watcher installation (§4.2).
    #[cfg(test)]
    pub fn loose_watcher_count(&self) -> usize {
        self.loose_watchers.read().len()
    }
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
fn reclassified_origin(
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
/// resolver (so the editor service can route through its shared cache).
fn resolver_for_origin(
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

/// The shared core of [`EditorService::handle_external_change`], callable from
/// the loose-file watcher's `on_change` callback (which holds clones of the
/// `Arc` fields rather than `&EditorService`). Implements the §8.4 rules: see
/// [`handle_external_change`](EditorService::handle_external_change) for the
/// full decision table.
///
/// Lock discipline mirrors [`update_text`](EditorService::update_text): brief
/// locks, no nested cross-service locks, the world text written via its own
/// interior `RwLock` outside the runtime mutex. Safe to run on the watcher
/// flush thread concurrently with compile workers and the IPC runtime.
fn handle_external_change_locked(
    path: &Path,
    tabs: &Tabs,
    registry: &SharedRegistry,
    workers: &Workers,
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
    tab.world.set_text(content);
    let mut rt = tab.state.lock();
    rt.meta.revision = rt.meta.revision.saturating_add(1);
    rt.meta.dirty = false;
    rt.meta.conflict = ConflictState::None;
    rt.disk_version = Some(new_version);
    drop(rt);
    if let Some(worker) = workers.read().get(&id) {
        worker.recompile();
    }
}

/// Helper: set a tab's conflict state and emit the corresponding event. Holds
/// the runtime lock only long enough to update `meta.conflict`.
fn set_conflict(
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

/// Whether `path` exists on disk (any type — file, dir, symlink target).
/// Used by [`handle_external_change_locked`] to distinguish a genuine deletion
/// (`NotFound` + path truly gone) from a transient read failure.
fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    // --- test doubles --------------------------------------------------------

    /// An event captured by `CapturingEmitter`, for assertion in tests.
    ///
    /// The payload fields mirror the real wire format so a test asserting on
    /// specifics (pages, diagnostics, status) has the data available, even
    /// though current assertions only check event presence + id. The `revision`
    /// field is the document revision the result corresponds to (§7).
    #[allow(dead_code)]
    #[derive(Clone, Debug)]
    enum CapturedEvent {
        Compiled {
            id: DocumentId,
            revision: u64,
            pages: Vec<String>,
            line_map: Vec<LineRect>,
            duration_ms: u64,
        },
        Diagnostics {
            id: DocumentId,
            revision: u64,
            diagnostics: Vec<Diagnostic>,
        },
        Status {
            id: DocumentId,
            revision: u64,
            status: CompileStatus,
            duration_ms: Option<u64>,
        },
        Conflict {
            id: DocumentId,
            revision: u64,
            conflict: ConflictState,
            disk_content: Option<String>,
        },
    }

    /// Records every emit into a vector so tests can assert on the event stream.
    struct CapturingEmitter {
        events: Mutex<Vec<CapturedEvent>>,
    }

    impl CapturingEmitter {
        fn new() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
            }
        }
        fn snapshot(&self) -> Vec<CapturedEvent> {
            self.events.lock().clone()
        }
        fn clear(&self) {
            self.events.lock().clear();
        }
        fn statuses_for(&self, id: DocumentId) -> Vec<CompileStatus> {
            self.snapshot()
                .into_iter()
                .filter_map(|e| match e {
                    CapturedEvent::Status { id: eid, status, .. } if eid == id => Some(status),
                    _ => None,
                })
                .collect()
        }
        /// Revisions of all `compiled` events for `id`, in emit order.
        fn compiled_revisions_for(&self, id: DocumentId) -> Vec<u64> {
            self.snapshot()
                .into_iter()
                .filter_map(|e| match e {
                    CapturedEvent::Compiled { id: eid, revision, .. } if eid == id => Some(revision),
                    _ => None,
                })
                .collect()
        }
        /// Conflict states emitted for `id`, in emit order.
        fn conflicts_for(&self, id: DocumentId) -> Vec<ConflictState> {
            self.snapshot()
                .into_iter()
                .filter_map(|e| match e {
                    CapturedEvent::Conflict { id: eid, conflict, .. } if eid == id => Some(conflict),
                    _ => None,
                })
                .collect()
        }
    }

    impl Emitter for CapturingEmitter {
        fn emit_compiled(
            &self,
            id: DocumentId,
            revision: u64,
            pages: Vec<String>,
            line_map: Vec<LineRect>,
            duration_ms: u64,
        ) {
            self.events.lock().push(CapturedEvent::Compiled {
                id,
                revision,
                pages,
                line_map,
                duration_ms,
            });
        }
        fn emit_diagnostics(&self, id: DocumentId, revision: u64, diagnostics: Vec<Diagnostic>) {
            self.events
                .lock()
                .push(CapturedEvent::Diagnostics { id, revision, diagnostics });
        }
        fn emit_status(
            &self,
            id: DocumentId,
            revision: u64,
            status: CompileStatus,
            duration_ms: Option<u64>,
        ) {
            self.events
                .lock()
                .push(CapturedEvent::Status { id, revision, status, duration_ms });
        }
        fn emit_conflict(
            &self,
            id: DocumentId,
            revision: u64,
            conflict: ConflictState,
            disk_content: Option<String>,
        ) {
            self.events
                .lock()
                .push(CapturedEvent::Conflict { id, revision, conflict, disk_content });
        }
    }

    /// Build an `EditorService` backed by a capturing emitter.
    fn make_service() -> (EditorService, Arc<CapturingEmitter>) {
        let emitter = Arc::new(CapturingEmitter::new());
        let svc = EditorService::new(emitter.clone());
        (svc, emitter)
    }

    /// Poll the emitter until a `compiled` event for `id` shows up (or panic
    /// after a timeout). Needed because `new_tab` compiles asynchronously on
    /// the worker thread.
    fn wait_for_compiled(emitter: &CapturingEmitter, id: DocumentId) {
        for _ in 0..60 {
            let got = emitter
                .snapshot()
                .iter()
                .any(|e| matches!(e, CapturedEvent::Compiled { id: eid, .. } if *eid == id));
            if got {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("no compiled event for {id} within timeout");
    }

    // --- tests ---------------------------------------------------------------

    #[test]
    fn new_tab_returns_unique_ids() {
        let (svc, _) = make_service();
        let a = svc.new_tab(None);
        let b = svc.new_tab(None);
        let c = svc.new_tab(None);
        assert_ne!(a.id, b.id);
        assert_ne!(b.id, c.id);
        assert_ne!(a.id, c.id);
        assert_eq!(svc.list_tabs().len(), 3);
    }

    #[test]
    fn new_tab_compiles_and_emits_compiled() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        wait_for_compiled(&emitter, meta.id);
        // The default template compiles cleanly → a compiled event is emitted.
        let compiled = emitter.snapshot().into_iter().any(|e| {
            matches!(e, CapturedEvent::Compiled { id, .. } if id == meta.id)
        });
        assert!(compiled, "expected a compiled event for the new tab");
        let statuses = emitter.statuses_for(meta.id);
        assert!(statuses.contains(&CompileStatus::Compiling));
        assert!(statuses.contains(&CompileStatus::Success));
        assert!(svc.last_doc(meta.id).is_some());
    }

    #[test]
    fn multi_tab_compile_isolation() {
        // R2: each tab must compile against its own world independently.
        let (svc, emitter) = make_service();
        let one = svc.new_tab(Some("#set page(width: 10cm)\n\nTab One".into()));
        let two = svc.new_tab(Some("#set page(width: 10cm)\n\nTab Two".into()));

        assert_ne!(one.id, two.id);

        // Wait for both tabs to finish their initial async compiles.
        wait_for_compiled(&emitter, one.id);
        wait_for_compiled(&emitter, two.id);

        // Each tab has its own document.
        let doc1 = svc.last_doc(one.id).expect("tab one should have a document");
        let doc2 = svc.last_doc(two.id).expect("tab two should have a document");
        assert!(
            !doc1.pages().is_empty() && !doc2.pages().is_empty(),
            "both tabs should produce pages"
        );

        // Compiling one tab must not affect the other's result.
        svc.compile_now(one.id);
        let doc2_after = svc.last_doc(two.id).expect("tab two document must persist");
        assert_eq!(
            doc2_after.pages().len(),
            doc2.pages().len(),
            "recompiling tab one must not disturb tab two"
        );

        // Both ids appear in the compiled event stream.
        let ids: Vec<DocumentId> = emitter
            .snapshot()
            .into_iter()
            .filter_map(|e| match e {
                CapturedEvent::Compiled { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        assert!(ids.contains(&one.id) && ids.contains(&two.id));
    }

    #[test]
    fn update_text_schedules_compile() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        emitter.clear(); // drop the initial-compile events.

        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited content".into())
            .unwrap();

        // The compile runs after the 300ms debounce on the scheduler's runtime.
        // Poll the emitter until the expected event shows up (or time out).
        let mut seen_compiled = false;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let got = emitter
                .snapshot()
                .iter()
                .any(|e| matches!(e, CapturedEvent::Compiled { id, .. } if *id == meta.id));
            if got {
                seen_compiled = true;
                break;
            }
        }
        assert!(seen_compiled, "debounced compile should emit `compiled`");

        let statuses = emitter.statuses_for(meta.id);
        assert!(statuses.contains(&CompileStatus::Compiling));
        assert!(statuses.contains(&CompileStatus::Success));
    }

    #[test]
    fn failing_source_emits_diagnostics() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        emitter.clear();

        svc.update_text(meta.id, "#assert(false)\n".into()).unwrap();
        // Wait for the debounced compile.
        for _ in 0..20 {
            if emitter
                .snapshot()
                .iter()
                .any(|e| matches!(e, CapturedEvent::Diagnostics { id, .. } if *id == meta.id))
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let diags = svc.get_diagnostics(meta.id);
        assert!(!diags.is_empty(), "failing source should yield diagnostics");
        let statuses = emitter.statuses_for(meta.id);
        assert!(statuses.contains(&CompileStatus::Error));
    }

    #[test]
    fn close_tab_releases_state() {
        let (svc, _) = make_service();
        let meta = svc.new_tab(None);
        assert_eq!(svc.list_tabs().len(), 1);
        svc.close_tab(meta.id).unwrap();
        assert!(svc.list_tabs().is_empty());
        assert!(svc.last_doc(meta.id).is_none());
        // Closing an unknown tab errors.
        assert!(svc.close_tab(DocumentId::new()).is_err());
    }

    #[test]
    fn save_file_writes_and_clears_dirty() {
        let tmp = std::env::temp_dir().join(format!("typst-studio-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nOriginal").unwrap();
        let (svc, _) = make_service();
        // Simulate what the command layer does: read content, open tab, then save.
        let initial = std::fs::read_to_string(&tmp).unwrap();
        let meta = svc.open_from_content(tmp.clone(), initial, None).unwrap();
        // Edit + prepare_save + write + clear_dirty (mirrors the async command).
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nSaved!".into())
            .unwrap();
        let (path, text) = svc.prepare_save(meta.id).unwrap();
        std::fs::write(&path, text).unwrap();
        svc.clear_dirty(meta.id);
        let on_disk = std::fs::read_to_string(&tmp).unwrap();
        assert!(on_disk.contains("Saved!"));
        assert!(!svc.tab_meta(meta.id).unwrap().dirty, "dirty flag must clear on save");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn save_untitled_errors() {
        let (svc, _) = make_service();
        let meta = svc.new_tab(None);
        assert!(svc.prepare_save(meta.id).is_err(), "untitled tab has no path to save to");
    }

    #[test]
    fn update_text_does_not_block_on_in_flight_compile() {
        // The core lock-contention fix: update_text must NOT block while a
        // compile is in flight on the same tab. The world is compiled without
        // any tab-level lock, so set_text can proceed concurrently.
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(Some(
            "#set page(width: 10cm)\n\nInitial".into(),
        ));
        wait_for_compiled(&emitter, meta.id);

        // Schedule a debounced compile (300ms). Before it fires, push a text
        // update. Both should succeed quickly — if the compile held a lock,
        // update_text would stall until the compile finishes.
        let start = std::time::Instant::now();
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited mid-flight".into())
            .unwrap();
        // Immediately schedule another update (the scheduler debounce resets).
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited again".into())
            .unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 50,
            "update_text must return near-instantly even with compile pending (took {elapsed:?})"
        );

        // Eventually the latest edit compiles.
        // Clear old events and wait for a fresh compile.
        emitter.clear();
        wait_for_compiled(&emitter, meta.id);
        assert!(svc.tab_text(meta.id).unwrap().contains("Edited again"));
    }

    #[test]
    fn update_text_bumps_revision_monotonically() {
        let (svc, _) = make_service();
        let meta = svc.new_tab(None);
        let r0 = svc.tab_revision(meta.id).unwrap();
        svc.update_text(meta.id, "a".into()).unwrap();
        let r1 = svc.tab_revision(meta.id).unwrap();
        svc.update_text(meta.id, "b".into()).unwrap();
        let r2 = svc.tab_revision(meta.id).unwrap();
        assert!(r1 > r0, "revision must increase on edit");
        assert!(r2 > r1, "revision must be strictly monotonic");
    }

    #[test]
    fn compiled_events_carry_revision() {
        // §7: every compile-related event carries the revision it corresponds
        // to, so the frontend can discard stale results.
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(Some("#set page(width: 10cm)\n\nHello".into()));
        wait_for_compiled(&emitter, meta.id);
        // The initial compile (revision 0) must carry revision 0.
        let revs = emitter.compiled_revisions_for(meta.id);
        assert!(revs.contains(&0), "initial compile must carry revision 0, got {revs:?}");
    }

    #[test]
    fn opening_same_canonical_path_dedups() {
        // §4.1 / §8.1: opening the same file twice yields one document.
        let tmp = std::env::temp_dir().join(format!("ts-dedup-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nOne").unwrap();
        let (svc, _) = make_service();
        let first = svc.open_from_content(tmp.clone(), "x".into(), None).unwrap();
        // Open via a different lexical path (`.` component) that canonicalizes
        // to the same file — must NOT create a second document.
        let via_dot = tmp.parent().unwrap().join(".").join(tmp.file_name().unwrap());
        let second = svc.open_from_content(via_dot, "y".into(), None).unwrap();
        assert_eq!(first.id, second.id, "same canonical path must dedup");
        assert_eq!(svc.list_tabs().len(), 1);
        assert_eq!(svc.registry().read().len(), 1);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn save_as_preserves_id_and_rebinds_registry() {
        // §4.1 / §8.3: Save As keeps the DocumentId and updates the canonical
        // path index.
        let dir = std::env::temp_dir().join(format!("ts-saveas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.typ");
        std::fs::write(&src, "#set page(width: 10cm)\n\nA").unwrap();
        let (svc, _) = make_service();
        let meta = svc.open_from_content(src.clone(), "x".into(), None).unwrap();
        let id_before = meta.id;
        // Save As to a new path in the same dir.
        let dst = dir.join("b.typ");
        std::fs::write(&dst, "x").unwrap(); // simulate the command layer's write
        svc.rebind_path(meta.id, dst.clone()).unwrap();
        // Canonicalize for comparison: `temp_dir()` may live under a symlink
        // (macOS `/var` → `/private/var`), and the registry stores canonical paths.
        let src_canon = canonicalize_for_identity(&src).unwrap();
        let dst_canon = canonicalize_for_identity(&dst).unwrap();
        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "Save As must preserve the DocumentId");
        assert_eq!(after.path.as_deref(), Some(dst_canon.as_path()));
        // Old canonical slot is free; new one is claimed.
        assert_eq!(
            svc.registry().read().find_by_canonical(&src_canon),
            None,
            "old canonical slot must be released after Save As"
        );
        assert_eq!(svc.registry().read().find_by_canonical(&dst_canon), Some(id_before));
        assert_eq!(svc.list_tabs().len(), 1, "still one document after rebind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_as_to_already_open_path_rejected() {
        // §8.3: target already bound to another document → reject, don't merge.
        let dir = std::env::temp_dir().join(format!("ts-conflict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.typ");
        let b = dir.join("b.typ");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "y").unwrap();
        // Canonicalize once — the registry keys on canonical paths, which may
        // differ from the literal `dir.join(...)` if `temp_dir()` is symlinked.
        let a_canon = canonicalize_for_identity(&a).unwrap();
        let b_canon = canonicalize_for_identity(&b).unwrap();
        let (svc, _) = make_service();
        let meta_a = svc.open_from_content(a.clone(), "x".into(), None).unwrap();
        let meta_b = svc.open_from_content(b.clone(), "y".into(), None).unwrap();
        // Try to Save As b onto a's path → must error.
        let err = svc.rebind_path(meta_b.id, a.clone()).unwrap_err();
        assert!(matches!(err, AppError::AlreadyOpen { .. }));
        // Both documents intact.
        assert_eq!(svc.list_tabs().len(), 2);
        assert_eq!(svc.tab_meta(meta_a.id).unwrap().path.as_deref(), Some(a_canon.as_path()));
        assert_eq!(svc.tab_meta(meta_b.id).unwrap().path.as_deref(), Some(b_canon.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loose_file_resolves_same_dir_include() {
        // §4.2: a loose file compiles with a parent-directory-rooted resolver,
        // so a same-dir `#include` resolves (broken before Task A).
        let dir = std::env::temp_dir().join(format!("ts-loose-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#include \"intro.typ\"\n").unwrap();
        std::fs::write(dir.join("intro.typ"), "Intro\n").unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        // The include must resolve → a document with at least one page exists.
        let doc = svc
            .last_doc(meta.id)
            .expect("loose file should compile with same-dir #include");
        assert!(
            !doc.pages().is_empty(),
            "compiled document must have pages"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebind_path_rebuilds_world_and_recompiles() {
        // §8.3 / §4.2: Save As rebuilds the world against the NEW parent dir, so
        // the recompiled document reflects the target's neighbors.
        let dir1 = std::env::temp_dir().join(format!("ts-rebind-1-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir().join(format!("ts-rebind-2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        // Source file includes intro.typ from its own directory.
        let src = dir1.join("main.typ");
        let text = "#include \"intro.typ\"\n";
        std::fs::write(&src, text).unwrap();
        std::fs::write(dir1.join("intro.typ"), "Intro in dir1\n").unwrap();
        // Target directory has its own intro.typ with different content.
        let dst = dir2.join("main.typ");
        std::fs::write(&dst, text).unwrap();
        std::fs::write(dir2.join("intro.typ"), "Intro in dir2\n").unwrap();

        let (svc, emitter) = make_service();
        let meta = svc.open_from_disk(src.clone(), text.to_string(), None).unwrap();
        wait_for_compiled(&emitter, meta.id);

        // Save As into dir2. The buffer + id are preserved, but the world is
        // rebuilt against dir2's parent — so the next compile resolves dir2's
        // intro.typ.
        emitter.clear(); // drop the initial-compile event so the wait below
                         // only returns once the post-rebind compile finishes.
        svc.rebind_path(meta.id, dst.clone()).unwrap();
        wait_for_compiled(&emitter, meta.id);

        // id preserved, registry points at the new canonical path, document
        // compiles (the new include resolved).
        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, meta.id, "Save As must preserve the DocumentId");
        let dst_canon = canonicalize_for_identity(&dst).unwrap();
        assert_eq!(after.path.as_deref(), Some(dst_canon.as_path()));
        assert_eq!(
            svc.registry().read().find_by_canonical(&dst_canon),
            Some(meta.id)
        );
        assert!(
            svc.last_doc(meta.id)
                .map(|d| !d.pages().is_empty())
                .unwrap_or(false),
            "rebound tab must recompile to a non-empty document"
        );
        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn rebind_path_preserves_buffer_and_revision() {
        // §4.1 / §7: Save As keeps the in-memory buffer and the revision counter.
        let dir = std::env::temp_dir().join(format!("ts-rebind-buf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.typ");
        std::fs::write(&src, "#set page(width: 10cm)\n\nOriginal").unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&src).unwrap();
        let meta = svc.open_from_disk(src.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        // Edit to bump the revision.
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited".into())
            .unwrap();
        let text_before = svc.tab_text(meta.id).unwrap();
        let rev_before = svc.tab_revision(meta.id).unwrap();
        assert!(rev_before > 0, "edit must have bumped the revision");

        let dst = dir.join("b.typ");
        std::fs::write(&dst, &text_before).unwrap();
        svc.rebind_path(meta.id, dst.clone()).unwrap();
        wait_for_compiled(&emitter, meta.id);

        assert_eq!(
            svc.tab_text(meta.id).as_deref(),
            Some(text_before.as_str()),
            "buffer must survive rebind"
        );
        assert_eq!(
            svc.tab_revision(meta.id),
            Some(rev_before),
            "revision must survive rebind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebind_path_to_already_open_target_rejected() {
        // §8.3: rebinding onto another document's path is rejected; both intact.
        let dir = std::env::temp_dir().join(format!("ts-rebind-conf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.typ");
        let b = dir.join("b.typ");
        std::fs::write(&a, "#set page(width: 10cm)\n\nA").unwrap();
        std::fs::write(&b, "#set page(width: 10cm)\n\nB").unwrap();
        let a_canon = canonicalize_for_identity(&a).unwrap();
        let b_canon = canonicalize_for_identity(&b).unwrap();
        let (svc, _) = make_service();
        let meta_a = svc.open_from_disk(a.clone(), "x".into(), None).unwrap();
        let meta_b = svc.open_from_disk(b.clone(), "y".into(), None).unwrap();
        // Rebind b onto a's path → conflict.
        let err = svc.rebind_path(meta_b.id, a.clone()).unwrap_err();
        assert!(matches!(err, AppError::AlreadyOpen { .. }));
        // Both documents intact at their original paths.
        assert_eq!(svc.list_tabs().len(), 2);
        assert_eq!(
            svc.tab_meta(meta_a.id).unwrap().path.as_deref(),
            Some(a_canon.as_path())
        );
        assert_eq!(
            svc.tab_meta(meta_b.id).unwrap().path.as_deref(),
            Some(b_canon.as_path())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loose_resolver_cache_shares_same_parent() {
        // §4.2: two loose files in the same directory share one cached resolver.
        let dir = std::env::temp_dir().join(format!("ts-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let one = dir.join("one.typ");
        let two = dir.join("two.typ");
        std::fs::write(&one, "#set page(width: 10cm)\n\nOne").unwrap();
        std::fs::write(&two, "#set page(width: 10cm)\n\nTwo").unwrap();
        let (svc, emitter) = make_service();
        let a = svc
            .open_from_disk(one.clone(), "#set page(width: 10cm)\n\nOne".into(), None)
            .unwrap();
        let b = svc
            .open_from_disk(two.clone(), "#set page(width: 10cm)\n\nTwo".into(), None)
            .unwrap();
        wait_for_compiled(&emitter, a.id);
        wait_for_compiled(&emitter, b.id);
        assert_ne!(a.id, b.id, "two distinct files → two distinct docs");
        assert_eq!(
            svc.loose_resolver_cache_len(),
            1,
            "both files share one parent → exactly one cached resolver"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- workspace reclassification (§4.3) -----------------------------------

    /// A no-op fs-change callback for the workspace watcher in tests.
    fn noop_on_change() -> crate::fs::watcher::OnChange {
        Arc::new(|_: &[PathBuf]| {})
    }

    /// §4.3: opening a workspace reclassifies an already-open loose file inside
    /// it to a `WorkspaceFile`, preserving id/buffer/revision and still
    /// compiling.
    #[test]
    fn reclassify_loose_to_workspace_on_open() {
        let dir = std::env::temp_dir().join(format!("ts-recl-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nHello").unwrap();

        let (svc, emitter) = make_service();
        // Open the file with NO workspace → it's a loose file.
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        let id_before = meta.id;
        assert!(
            matches!(meta.origin, DocumentOrigin::LooseFile { .. }),
            "without a workspace the file must classify as LooseFile"
        );

        // Open a workspace rooted at the file's dir and reclassify.
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let ws_id = ws.workspace_id().unwrap();
        emitter.clear(); // drop the initial-compile event so the wait below
                         // only returns once the post-reclassify compile finishes.
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "DocumentId must survive reclassify");
        match after.origin {
            DocumentOrigin::WorkspaceFile { workspace_id, .. } => {
                assert_eq!(workspace_id, ws_id, "origin must carry the new workspace id");
            }
            ref other => panic!("expected WorkspaceFile, got {other:?}"),
        }
        // Buffer + revision preserved.
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some("#set page(width: 10cm)\n\nHello"));
        assert_eq!(svc.tab_revision(meta.id), Some(0));

        // The rebuilt world still compiles (the worker recompiles).
        wait_for_compiled(&emitter, meta.id);
        assert!(
            svc.last_doc(meta.id).map(|d| !d.pages().is_empty()).unwrap_or(false),
            "reclassified tab must recompile to a non-empty document"
        );
        ws.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3: closing a workspace demotes a `WorkspaceFile` to a `LooseFile`
    /// rooted at its parent dir (so same-dir `#include` still resolves),
    /// preserving id/buffer.
    #[test]
    fn reclassify_workspace_to_loose_on_close() {
        let dir = std::env::temp_dir().join(format!("ts-recl-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        // An include that must keep resolving after demotion (parent-rooted).
        std::fs::write(&main, "#include \"intro.typ\"\n").unwrap();
        std::fs::write(dir.join("intro.typ"), "Intro\n").unwrap();

        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        // Open WITH a workspace → it's a WorkspaceFile.
        let meta = svc.open_from_disk(main.clone(), content, Some(&ws)).unwrap();
        wait_for_compiled(&emitter, meta.id);
        let id_before = meta.id;
        assert!(
            matches!(meta.origin, DocumentOrigin::WorkspaceFile { .. }),
            "inside an open workspace the file must classify as WorkspaceFile"
        );

        // Close the workspace and reclassify → demote to LooseFile.
        ws.close();
        emitter.clear();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before, "DocumentId must survive reclassify");
        match &after.origin {
            DocumentOrigin::LooseFile { root, .. } => {
                assert_eq!(root, &canonicalize_for_identity(&dir).unwrap());
            }
            other => panic!("expected LooseFile after close, got {other:?}"),
        }
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some("#include \"intro.typ\"\n"));

        // The parent-rooted resolver still resolves the same-dir include.
        wait_for_compiled(&emitter, meta.id);
        assert!(
            svc.last_doc(meta.id).map(|d| !d.pages().is_empty()).unwrap_or(false),
            "demoted loose file must still resolve its same-dir #include"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3 / §7: reclassification preserves `dirty` and `revision` (only Save
    /// As / save clears dirty).
    #[test]
    fn reclassify_preserves_dirty_and_revision() {
        let dir = std::env::temp_dir().join(format!("ts-recl-dirty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nOriginal").unwrap();

        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, Some(&ws)).unwrap();
        wait_for_compiled(&emitter, meta.id);
        // Edit → dirty + bumped revision.
        svc.update_text(meta.id, "#set page(width: 10cm)\n\nEdited".into())
            .unwrap();
        wait_for_compiled(&emitter, meta.id);
        let rev_before = svc.tab_revision(meta.id).unwrap();
        let text_before = svc.tab_text(meta.id).unwrap();
        assert!(rev_before > 0, "edit must have bumped the revision");
        assert!(svc.tab_meta(meta.id).unwrap().dirty, "must be dirty after edit");

        // Close + reclassify → dirty + revision survive.
        ws.close();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(svc.tab_revision(meta.id), Some(rev_before), "revision preserved");
        assert!(after.dirty, "dirty must survive reclassification");
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some(text_before.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3: `Untitled` documents are never reclassified.
    #[test]
    fn reclassify_untitled_untouched() {
        let (svc, emitter) = make_service();
        let meta = svc.new_tab(None);
        wait_for_compiled(&emitter, meta.id);
        let text_before = svc.tab_text(meta.id).unwrap();
        let rev_before = svc.tab_revision(meta.id).unwrap();

        let ws = WorkspaceService::new();
        let dir = std::env::temp_dir().join(format!("ts-recl-unt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        svc.reclassify_documents(&ws);
        ws.close();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert!(
            after.origin.is_untitled(),
            "untitled origin must be untouched by reclassify"
        );
        assert_eq!(svc.tab_text(meta.id).as_deref(), Some(text_before.as_str()));
        assert_eq!(svc.tab_revision(meta.id), Some(rev_before));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4.3: a loose file OUTSIDE the workspace root stays loose when a
    /// workspace opens.
    #[test]
    fn reclassify_outside_workspace_stays_loose() {
        let ws_dir =
            std::env::temp_dir().join(format!("ts-recl-out-ws-{}", uuid::Uuid::new_v4()));
        let outside_dir =
            std::env::temp_dir().join(format!("ts-recl-out-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();
        let main = outside_dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nOutside").unwrap();

        let (svc, emitter) = make_service();
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, None).unwrap();
        wait_for_compiled(&emitter, meta.id);
        let id_before = meta.id;
        assert!(matches!(meta.origin, DocumentOrigin::LooseFile { .. }));

        // Open a workspace that does NOT contain the file → stays loose.
        let ws = WorkspaceService::new();
        ws.open(ws_dir.clone(), noop_on_change()).unwrap();
        svc.reclassify_documents(&ws);

        let after = svc.tab_meta(meta.id).unwrap();
        assert_eq!(after.id, id_before);
        assert!(
            matches!(after.origin, DocumentOrigin::LooseFile { .. }),
            "file outside the workspace must stay LooseFile"
        );
        ws.close();
        let _ = std::fs::remove_dir_all(&ws_dir);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn reclassify_stale_workspacefile_is_reclaimed_with_new_id() {
        // Open a file as WorkspaceFile(id1), close the workspace (demotes to
        // LooseFile), reopen the SAME folder (new id2), reclassify — the doc
        // must be re-claimed as WorkspaceFile carrying id2 (not left stale).
        let dir = std::env::temp_dir().join(format!("ts-recl-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nStale").unwrap();

        let (svc, emitter) = make_service();
        let ws = WorkspaceService::new();
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let id1 = ws.workspace_id().expect("workspace open has an id");
        // Open inside the workspace → classifies as WorkspaceFile(id1).
        let content = std::fs::read_to_string(&main).unwrap();
        let meta = svc.open_from_disk(main.clone(), content, Some(&ws)).unwrap();
        wait_for_compiled(&emitter, meta.id);
        match &svc.tab_meta(meta.id).unwrap().origin {
            DocumentOrigin::WorkspaceFile { workspace_id, .. } => {
                assert_eq!(*workspace_id, id1, "should be claimed by the first workspace");
            }
            other => panic!("expected WorkspaceFile, got {other:?}"),
        }

        // Close → demote to LooseFile.
        ws.close();
        svc.reclassify_documents(&ws);
        assert!(matches!(
            svc.tab_meta(meta.id).unwrap().origin,
            DocumentOrigin::LooseFile { .. }
        ));

        // Reopen the SAME folder → a fresh WorkspaceId.
        ws.open(dir.clone(), noop_on_change()).unwrap();
        let id2 = ws.workspace_id().expect("reopened workspace has an id");
        assert_ne!(id1, id2, "each open must mint a fresh WorkspaceId");
        svc.reclassify_documents(&ws);

        // The doc is re-claimed by the new workspace, carrying id2.
        let id_preserved = meta.id;
        match &svc.tab_meta(meta.id).unwrap().origin {
            DocumentOrigin::WorkspaceFile { workspace_id, .. } => {
                assert_eq!(*workspace_id, id2, "stale doc must be re-claimed with the new id");
            }
            other => panic!("expected WorkspaceFile after reopen, got {other:?}"),
        }
        assert_eq!(svc.tab_meta(meta.id).unwrap().id, id_preserved, "DocumentId stable");

        ws.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- external-modification handling (§8.4, Task B2) ---------------------

    /// Create a temp `.typ` file with the given content and return its path.
    fn make_tmp_file(content: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("ts-conflict-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        p
    }

    /// Open a file as a disk-backed tab (clean) and wait for its first compile.
    fn open_clean_file(svc: &EditorService, emitter: &CapturingEmitter, path: &Path) -> DocumentId {
        let content = std::fs::read_to_string(path).unwrap();
        let meta = svc.open_from_disk(path.to_path_buf(), content, None).unwrap();
        wait_for_compiled(emitter, meta.id);
        // Wait for the disk_version to be seeded (open_from_disk sets it after
        // the worker is created; it reads the file synchronously).
        for _ in 0..40 {
            let seeded = svc
                .tabs
                .read()
                .get(&meta.id)
                .map(|t| t.state.lock().disk_version.is_some())
                .unwrap_or(false);
            if seeded {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        meta.id
    }

    /// §8.4: a clean buffer auto-reloads from disk on external change (revision
    /// bumps, dirty stays false, content updates), then recompiles.
    #[test]
    fn handle_external_change_clean_buffer_auto_reloads() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nOriginal");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let rev_before = svc.tab_revision(id).unwrap();
        assert!(!svc.tab_meta(id).unwrap().dirty);

        // Externally modify the file (buffer is clean).
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nChanged on disk").unwrap();
        svc.handle_external_change(&tmp);

        // Buffer reloaded to the new content; revision bumped; still not dirty.
        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some("#set page(width: 10cm)\n\nChanged on disk"),
            "clean buffer must reload from disk"
        );
        assert!(
            svc.tab_revision(id).unwrap() > rev_before,
            "reload must bump the revision"
        );
        assert!(
            !svc.tab_meta(id).unwrap().dirty,
            "auto-reload must not mark the buffer dirty"
        );
        assert_eq!(svc.tab_meta(id).unwrap().conflict, ConflictState::None);
        // The reload signals a recompile.
        emitter.clear();
        wait_for_compiled(&emitter, id);
        let _ = std::fs::remove_file(&tmp);
    }

    /// §8.4: a dirty buffer with an external change enters `Modified` conflict
    /// — the buffer is NEVER clobbered.
    #[test]
    fn handle_external_change_dirty_buffer_enters_conflict() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nOriginal");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        // Dirty the buffer with unsaved edits.
        svc.update_text(id, "#set page(width: 10cm)\n\nMy local edit".into())
            .unwrap();
        wait_for_compiled(&emitter, id);
        let text_before = svc.tab_text(id).unwrap();
        let rev_before = svc.tab_revision(id).unwrap();

        // Externally modify the file — buffer is dirty → conflict, no clobber.
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nChanged on disk").unwrap();
        svc.handle_external_change(&tmp);

        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some(text_before.as_str()),
            "dirty buffer must NOT be clobbered"
        );
        assert_eq!(svc.tab_revision(id), Some(rev_before), "no reload → no revision bump");
        assert_eq!(
            svc.tab_meta(id).unwrap().conflict,
            ConflictState::Modified,
            "must enter Modified conflict"
        );
        // A conflict event was emitted.
        assert!(
            emitter.conflicts_for(id).contains(&ConflictState::Modified),
            "expected a Modified conflict event"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    /// §8.4: deleting the backing file marks the document `Missing` but
    /// preserves the buffer.
    #[test]
    fn handle_external_change_deleted_file_marks_missing() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nHello");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let text_before = svc.tab_text(id).unwrap();

        // Delete the file then deliver the watcher event.
        std::fs::remove_file(&tmp).unwrap();
        svc.handle_external_change(&tmp);

        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some(text_before.as_str()),
            "buffer must be preserved on deletion"
        );
        assert_eq!(
            svc.tab_meta(id).unwrap().conflict,
            ConflictState::Missing,
            "deleted file must mark Missing"
        );
        assert!(emitter.conflicts_for(id).contains(&ConflictState::Missing));
    }

    /// §8.4 "仅时间戳变化但内容未变": a touch (same bytes, new mtime) must NOT
    /// reload — the revision is unchanged.
    #[test]
    fn handle_external_change_mtime_only_no_reload() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nSame");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        let rev_before = svc.tab_revision(id).unwrap();
        let text_before = svc.tab_text(id).unwrap();

        // Rewrite identical bytes after a short sleep to advance the mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nSame").unwrap();
        svc.handle_external_change(&tmp);

        assert_eq!(svc.tab_revision(id), Some(rev_before), "mtime-only change must not bump revision");
        assert_eq!(svc.tab_text(id), Some(text_before), "buffer unchanged");
        assert_eq!(svc.tab_meta(id).unwrap().conflict, ConflictState::None);
        let _ = std::fs::remove_file(&tmp);
    }

    /// §8.2: the app's own save must NOT trigger a conflict/reload. After the
    /// save path (prepare_save → write → mark_saved), the watcher event for our
    /// write compares equal (disk_version matches) → no-op.
    #[test]
    fn self_save_does_not_trigger_conflict() {
        let tmp = make_tmp_file("#set page(width: 10cm)\n\nOriginal");
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &tmp);
        // Edit + save via the same path the command layer uses.
        svc.update_text(id, "#set page(width: 10cm)\n\nSaved!".into())
            .unwrap();
        wait_for_compiled(&emitter, id);
        let (path, text) = svc.prepare_save(id).unwrap();
        std::fs::write(&path, &text).unwrap();
        svc.mark_saved(id); // records the on-disk version of our write.
        assert!(!svc.tab_meta(id).unwrap().dirty, "mark_saved clears dirty");
        assert_eq!(svc.tab_meta(id).unwrap().conflict, ConflictState::None);

        let rev_before = svc.tab_revision(id).unwrap();
        let text_before = svc.tab_text(id).unwrap();

        // Simulate the watcher firing for our own write.
        svc.handle_external_change(&tmp);

        assert_eq!(
            svc.tab_revision(id),
            Some(rev_before),
            "self-save must not bump the revision"
        );
        assert_eq!(svc.tab_text(id), Some(text_before), "buffer unchanged on self-save");
        assert_eq!(
            svc.tab_meta(id).unwrap().conflict,
            ConflictState::None,
            "self-save must not enter conflict"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    /// §4.2 / §8.4: opening a loose file OUTSIDE the workspace installs a
    /// parent-directory watcher (the workspace watcher does not cover it).
    #[test]
    fn loose_file_watcher_installed_for_out_of_workspace_file() {
        let dir = std::env::temp_dir()
            .join(format!("ts-loose-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nLoose").unwrap();
        let (svc, emitter) = make_service();
        let id = open_clean_file(&svc, &emitter, &main);
        assert!(
            matches!(svc.tab_meta(id).unwrap().origin, DocumentOrigin::LooseFile { .. }),
            "without a workspace the file must be loose"
        );
        assert_eq!(
            svc.loose_watcher_count(),
            1,
            "exactly one parent-dir watcher for the loose file"
        );

        // Behaviourally: a real external change reaches handle_external_change
        // (we call it directly since the watcher's 300ms debounce is timing-
        // dependent and already tested in watcher.rs).
        std::fs::write(&main, "#set page(width: 10cm)\n\nChanged").unwrap();
        svc.handle_external_change(&main);
        assert_eq!(
            svc.tab_text(id).as_deref(),
            Some("#set page(width: 10cm)\n\nChanged"),
            "loose-file external change reloads the clean buffer"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Same-dir loose files share ONE watcher (§4.2 cache sharing for watchers
    /// too), and a second distinct dir gets a second watcher.
    #[test]
    fn loose_watchers_share_same_parent_dir() {
        let dir1 = std::env::temp_dir()
            .join(format!("ts-loose-share-1-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir()
            .join(format!("ts-loose-share-2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        let a = dir1.join("a.typ");
        let b = dir1.join("b.typ");
        let c = dir2.join("c.typ");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "y").unwrap();
        std::fs::write(&c, "z").unwrap();
        let (svc, emitter) = make_service();
        open_clean_file(&svc, &emitter, &a);
        open_clean_file(&svc, &emitter, &b);
        assert_eq!(svc.loose_watcher_count(), 1, "two same-dir files share one watcher");
        open_clean_file(&svc, &emitter, &c);
        assert_eq!(svc.loose_watcher_count(), 2, "a second distinct dir adds a second watcher");
        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn handle_external_change_for_unrelated_path_is_noop() {
        // The workspace watcher routes EVERY changed path through
        // handle_external_change; most don't correspond to an open document and
        // must be silently ignored (no panic, no events, no state change).
        let dir = std::env::temp_dir().join(format!("ts-noop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.typ");
        std::fs::write(&main, "#set page(width: 10cm)\n\nUnrelated").unwrap();
        let (svc, emitter) = make_service();
        open_clean_file(&svc, &emitter, &main);
        emitter.clear();

        // A path with no open document — must not panic or emit anything.
        let other = dir.join("notes.typ");
        std::fs::write(&other, "changed").unwrap();
        svc.handle_external_change(&other);
        // Also exercise a totally bogus path.
        svc.handle_external_change(std::path::Path::new("/nonexistent-ts-xyz/none.typ"));

        // No conflict, no compile events for our tab.
        let snaps = emitter.snapshot();
        assert!(
            snaps.iter().all(|e| !matches!(
                e,
                CapturedEvent::Conflict { id, .. } if *id == svc.tab_meta(svc.list_tabs()[0].id).unwrap().id
            )),
            "unrelated path must not raise a conflict: {snaps:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
