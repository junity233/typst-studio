//! `DocumentService` — document identity, buffers, and lifecycle (§6.1).
//!
//! Phase 4 splits the old monolithic editor service along the seam drawn in
//! design §6.1. `DocumentService` is the **document** half: it owns document
//! identity + the [`DocumentRegistry`](crate::domain::registry::DocumentRegistry),
//! buffer/dirty/revision/disk-version state, path canonicalization + dedup,
//! origin transitions (Untitled↔WorkspaceFile↔LooseFile), and conflict state.
//! It provides immutable snapshots (`{documentId, revision, text}`) that
//! [`CompileService`](super::compile_service::CompileService), the LSP layer,
//! save, and export consume.
//!
//! ## Split shape (§14 "渐进拆分")
//!
//! The fields that change on document lifecycle events (`tabs`, `registry`,
//! `loose_resolvers`, `loose_watchers`, `vfs`, `emitter`) live in a shared
//! [`TabStore`](super::tab_store::TabStore) that this service and
//! [`CompileService`] both reference. The `workers` map is also shared, because
//! several document operations (open, close, Save As, reclassify) spawn or
//! rotate the compile worker for the affected document — a coupling that
//! surfaces whenever a document's origin changes. Forcing a hermetic split on
//! day one would re-introduce the `Arc<EditorService>` cycle the pre-split code
//! deliberately avoided, so the boundary here is *structural* (a real service
//! with the §6.1 method surface) rather than hermetic. Tightening it is
//! follow-up work.
//!
//! [`CompileService`]: super::compile_service::CompileService

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::domain::disk_version::DiskVersion;
use crate::domain::document::{ConflictState, DocumentId, DocumentMeta, DocumentOrigin};
use crate::domain::path::canonicalize_for_identity;
use crate::domain::registry::SharedRegistry;
use crate::error::{AppError, Result};
use crate::typst_engine::world::EditorWorld;

use super::compile_service::CompileService;
use super::tab_state::TabState;
use super::tab_store::{
    classify_new, find_existing, handle_external_change_locked, loose_resolver_for,
    loose_watcher_for, reclassified_origin, resolver_for_origin, TabStore,
};
use super::workspace_service::WorkspaceService;

/// Default content for a fresh untitled tab.
const DEFAULT_TEMPLATE: &str = "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

/// The document-identity half of the editor (§6.1).
///
/// Owns (via the shared [`TabStore`]) the document map, registry, loose-file
/// caches, and VFS. A back-reference to the sibling [`CompileService`] lets the
/// lifecycle methods rotate compile workers when a document's origin changes
/// (Save As, reclassify) — the one unavoidable coupling between the two halves.
pub struct DocumentService {
    pub(crate) store: TabStore,
    /// Worker rotation on origin changes needs the compile service. Held by
    /// `Arc` and wired in [`with_compile`](Self::with_compile) after both
    /// services exist (breaks the construction cycle).
    compile: Mutex<Option<Arc<CompileService>>>,
}

impl DocumentService {
    /// Construct a document service over a fresh shared store.
    pub fn new(store: TabStore) -> Self {
        Self {
            store,
            compile: Mutex::new(None),
        }
    }

    /// Wire the sibling compile service, used for worker rotation when a
    /// document's origin changes. Call once after both services are built.
    pub fn with_compile(&self, compile: Arc<CompileService>) {
        *self.compile.lock() = Some(compile);
    }

    /// Read-only access to the document registry (for the IPC layer to detect
    /// "already open" before creating a duplicate).
    pub fn registry(&self) -> &SharedRegistry {
        self.store.registry()
    }

    /// Read-only access to the shared backing store (used by the facade's
    /// test-only accessors).
    #[cfg(test)]
    pub(crate) fn store(&self) -> &TabStore {
        &self.store
    }

    // --- open / create ------------------------------------------------------

    /// Create a new untitled tab and start its compile worker. Returns
    /// immediately; the initial compile runs on the worker thread.
    pub fn new_tab(&self, content: Option<String>) -> DocumentMeta {
        let text = content.unwrap_or_else(|| DEFAULT_TEMPLATE.to_string());
        let meta = DocumentMeta::new_untitled();
        let id = meta.id;
        // Untitled docs carry no canonical path, so the registry never rejects
        // them (multiple untitleds coexist).
        self.store
            .registry
            .write()
            .register(meta.clone())
            .expect("untitled registration cannot conflict");
        let tab = Arc::new(TabState::with_meta(meta.clone(), text));
        self.store.tabs.write().insert(id, tab.clone());
        self.compile().create_worker(id, tab);
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
        if let Some(existing) = find_existing(&self.store, &canon) {
            return Ok(existing);
        }
        let meta = classify_new(DocumentId::new(), canon.clone(), workspace);
        let id = meta.id;
        self.store.registry.write().register(meta.clone())?;
        let tab = self.tab_from_meta(&meta, &content, workspace);
        self.store.tabs.write().insert(id, tab.clone());
        self.compile().create_worker(id, tab);
        // Seed the on-disk version (§8.4) and ensure a watcher covers this
        // file's directory (the workspace watcher for in-workspace files, a
        // parent-dir watcher for out-of-workspace loose files).
        self.set_disk_version_from_path(id, meta.origin.canonical_path());
        self.ensure_dir_watched(id, &meta.origin, workspace);
        // Publish the initial buffer into the shared VFS (§5 end) so other tabs
        // that #include / #read this file compile against it (not disk).
        self.sync_vfs_for(id);
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
        if let Some(existing) = find_existing(&self.store, &canon) {
            return Ok(existing);
        }
        let meta = classify_new(DocumentId::new(), canon.clone(), workspace);
        let id = meta.id;
        self.store.registry.write().register(meta.clone())?;
        let tab = self.tab_from_meta(&meta, &content, workspace);
        self.store.tabs.write().insert(id, tab.clone());
        self.compile().create_worker(id, tab);
        // Seed the on-disk version (§8.4) and ensure a watcher covers this
        // file's directory (the workspace watcher for in-workspace files, a
        // parent-dir watcher for out-of-workspace loose files).
        self.set_disk_version_from_path(id, meta.origin.canonical_path());
        self.ensure_dir_watched(id, &meta.origin, workspace);
        // Publish the initial buffer into the shared VFS (§5 end).
        self.sync_vfs_for(id);
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
                Some(self.store.vfs.clone()),
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
        let resolver = loose_resolver_for(&self.store, root);
        self.build_tab(meta, text, Some(resolver), canon)
    }

    // --- external-modification support (§8.4) --------------------------------

    /// Seed (or refresh) a tab's [`DiskVersion`] from its on-disk file (§8.4).
    /// Best-effort: if the file can't be read (untitled / deleted mid-open), the
    /// version is left as-is. Called on open and after Save As rebind.
    fn set_disk_version_from_path(&self, id: DocumentId, path: Option<&Path>) {
        let Some(path) = path else { return };
        let Ok(version) = DiskVersion::from_path(path) else {
            return;
        };
        if let Some(t) = self.store.tabs.read().get(&id) {
            t.state.lock().disk_version = Some(version);
        }
    }

    // --- in-memory VFS overlay (§5 end) ---------------------------------------

    /// Publish a tab's current buffer + revision into the shared VFS under its
    /// canonical path, so any OTHER tab that `#include`s / `#read`s this file
    /// compiles against the live buffer instead of disk. No-op for untitled
    /// documents (no canonical path) and missing tabs. The main document's own
    /// compile never reads itself through the VFS — it's served from the
    /// world's `source` directly — but another tab including it still benefits.
    fn sync_vfs_for(&self, id: DocumentId) {
        let Some((canon, text, revision)) = self.vfs_snapshot(id) else {
            return;
        };
        self.store.vfs.upsert(canon, text, revision);
    }

    /// Remove a tab's buffer from the VFS by its canonical path (e.g. on
    /// close). No-op for untitled documents / missing tabs / untracked paths.
    fn drop_vfs_for(&self, id: DocumentId) {
        let Some((canon, _, _)) = self.vfs_snapshot(id) else {
            // Fallback: the tab may already be gone from `tabs` (close path
            // removes it before calling). Accept a best-effort remove keyed on
            // nothing — there's nothing to drop in that case.
            return;
        };
        self.store.vfs.remove(&canon);
    }

    /// Snapshot `(canonical_path, current_text, revision)` for a tab, or `None`
    /// when the tab is missing / untitled (no canonical path).
    fn vfs_snapshot(&self, id: DocumentId) -> Option<(PathBuf, String, u64)> {
        let tabs = self.store.tabs.read();
        let tab = tabs.get(&id)?;
        let rt = tab.state.lock();
        let canon = rt.meta.origin.canonical_path()?.to_path_buf();
        // Read text outside the state lock to keep the critical section short;
        // the world has its own interior lock. `tab` is still borrowed through
        // `tabs`, but we drop `rt` first.
        let revision = rt.meta.revision;
        drop(rt);
        let text = tab.world.text();
        Some((canon, text, revision))
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
            loose_watcher_for(&self.store, root);
        }
    }

    // --- save / dirty --------------------------------------------------------

    /// Mark a tab as saved: clear the dirty flag AND recompute + store the
    /// on-disk [`DiskVersion`] from the freshly-written file (§8.2 / §8.4).
    ///
    /// This MUST be called **after** the IPC layer's `std::fs::write` returns,
    /// so the stored version matches the bytes on disk. Then, when the watcher
    /// fires for the file we just wrote, the external-change handler sees the
    /// new disk version equals the stored one and treats the event as
    /// self-induced (no reload, no conflict). Replaces the old
    /// [`clear_dirty`](Self::clear_dirty) in the save path.
    pub fn mark_saved(&self, id: DocumentId) {
        let path = {
            let tabs = self.store.tabs.read();
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
            &self.store.tabs,
            &self.store.registry,
            &self.store.workers,
            &self.store.vfs,
            &self.store.emitter,
        );
    }

    /// Clear the dirty flag after a successful save.
    pub fn clear_dirty(&self, id: DocumentId) {
        if let Some(t) = self.store.tabs.read().get(&id) {
            t.state.lock().meta.dirty = false;
        }
    }

    /// Set a tab's dirty flag to `dirty` (§13). Used by the session-restore
    /// path to re-mark a document dirty when it was dirty at shutdown. For a
    /// restored disk file this signals "you had unsaved edits at shutdown that
    /// are now lost" — the on-disk bytes are loaded, then the tab is marked
    /// dirty so the user is alerted. No-op if the tab is not open.
    pub fn set_dirty(&self, id: DocumentId, dirty: bool) {
        if let Some(t) = self.store.tabs.read().get(&id) {
            t.state.lock().meta.dirty = dirty;
        }
    }

    // --- rebind / reclassify (origin transitions) ----------------------------

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

        // Snapshot the current buffer + revision + old canonical path before
        // mutating anything, so a registry conflict leaves the tab fully intact.
        let (text, revision, old_canon) = {
            let tabs = self.store.tabs.read();
            let tab = tabs
                .get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?;
            let rt = tab.state.lock();
            (
                tab.world.text(),
                rt.meta.revision,
                rt.meta.origin.canonical_path().map(|p| p.to_path_buf()),
            )
        };

        // New metadata: loose file at the target, clean, revision carried over.
        let new_meta = DocumentMeta {
            dirty: false,
            revision,
            ..DocumentMeta::with_loose_path(id, canon.clone(), root.clone())
        };

        // Rebind the registry first — on conflict, nothing below runs.
        self.store
            .registry
            .write()
            .rebind(id, new_meta.clone())?;

        // Rebuild the world against the new parent directory. `build_loose_tab`
        // carries the meta (incl. revision) and resets the compile result via
        // `with_meta_and_world`; falls back to a detached world on anchor failure.
        let new_tab = self.build_loose_tab(&new_meta, &text, &root, &canon);

        // Re-key the shared VFS (§5 end): drop the entry under the OLD canonical
        // path (if any) and publish the buffer under the NEW one, so other tabs
        // that #include this file resolve to its post-Save-As location.
        if let Some(old) = &old_canon {
            if old.as_path() != canon.as_path() {
                self.store.vfs.remove(old);
            }
        }
        self.store.vfs.upsert(canon.clone(), text.clone(), revision);

        // Swap the new world in and rotate the worker to trigger a recompile.
        self.swap_world(id, new_tab);

        // The rebuilt tab's runtime starts with `disk_version: None`. Seed it
        // from the freshly-written target file (Save As just wrote it), so the
        // imminent watcher event for that write is recognized as self-induced
        // (§8.2). Also ensure the target's parent dir is watched — Save As to a
        // directory outside the workspace needs a loose watcher to catch
        // future external changes (§4.2).
        self.set_disk_version_from_path(id, Some(&canon));
        loose_watcher_for(&self.store, &root);
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
        self.store.tabs.write().insert(id, new_tab.clone());
        // There's a sub-millisecond window between dropping the old worker and
        // spawning the new one where an update_text could arrive and find no
        // worker (its recompile signal is dropped). Acceptable since both
        // callers (Save As, reclassify) are user-initiated and the buffer is
        // already captured in the new world.
        let _ = self.store.workers.write().remove(&id);
        self.compile().create_worker(id, new_tab);
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
        let ids: Vec<DocumentId> = self.store.tabs.read().keys().copied().collect();
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
            let tabs = self.store.tabs.read();
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
            loose_resolver_for(&self.store, parent)
        });

        // Update the registry first (idempotent rebind — same canonical path).
        // A conflict here would be a bug (the path didn't move), but rebind is
        // fallible so honour the Result: on the impossible conflict, leave the
        // tab untouched rather than half-swap.
        if self
            .store
            .registry
            .write()
            .rebind(id, new_meta.clone())
            .is_err()
        {
            return;
        }

        let new_tab = self.build_tab(&new_meta, &text, resolver, &canon);
        self.swap_world(id, new_tab);

        // Restore the disk_version (the rebuild reset it to None). The file is
        // unchanged, so the pre-transition snapshot is still accurate.
        if let Some(dv) = disk_version {
            if let Some(t) = self.store.tabs.read().get(&id) {
                t.state.lock().disk_version = Some(dv);
            }
        }

        // If the document is now a LooseFile outside the workspace, make sure
        // its parent dir is watched for external changes (§4.2). In-workspace
        // files are covered by the workspace watcher.
        if let DocumentOrigin::LooseFile { root, path, .. } = &new_origin {
            let inside = ws.is_open() && (ws.contains(path) || ws.contains(root));
            if !inside {
                loose_watcher_for(&self.store, root);
            }
        }
    }

    // --- close / edit --------------------------------------------------------

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
        let _ = self.store.workers.write().remove(&id);
        // Remove the buffer from the shared VFS BEFORE dropping the tab, while
        // we can still read its canonical path. Best-effort (no-op for untitled).
        self.drop_vfs_for(id);
        let removed = self.store.tabs.write().remove(&id);
        if removed.is_none() {
            return Err(AppError::NotFound(format!("tab {id} not found")));
        }
        // Release the canonical-path slot so the file can be reopened.
        self.store.registry.write().unregister(id);
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
            let tabs = self.store.tabs.read();
            tabs.get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?
        };
        tab.world.set_text(content.clone());
        // Atomically bump revision + set dirty under one lock.
        let (revision, canon) = {
            let mut rt = tab.state.lock();
            rt.meta.revision = rt.meta.revision.saturating_add(1);
            let revision = rt.meta.revision;
            rt.meta.dirty = true;
            let canon = rt.meta.origin.canonical_path().map(|p| p.to_path_buf());
            (revision, canon)
        };
        // Publish the edited buffer into the shared VFS (§5 end): another tab
        // that #includes / #reads this file must compile against the live edit,
        // not the stale disk copy. Only for documents with a canonical path.
        if let Some(canon) = canon {
            self.store.vfs.upsert(canon, content, revision);
        }
        // Signal the worker. If it's busy compiling, the message queues; the
        // worker picks up the latest text when it finishes.
        if let Some(worker) = self.store.workers.read().get(&id) {
            worker.recompile();
        }
        Ok(())
    }

    /// Prepare data needed to save a tab: returns `(path, current_text)`. The
    /// command layer does the actual disk write (async). Errors if the tab is
    /// untitled (no path) or missing.
    pub fn prepare_save(&self, id: DocumentId) -> Result<(PathBuf, String)> {
        let tab = {
            let tabs = self.store.tabs.read();
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

    // --- accessors -----------------------------------------------------------

    /// Metadata for a single tab, if present.
    pub fn tab_meta(&self, id: DocumentId) -> Option<DocumentMeta> {
        self.store
            .tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().meta.clone())
    }

    /// The current content revision for a tab (§7). Bumped on every
    /// [`update_text`](Self::update_text). `None` if the tab is not open.
    pub fn tab_revision(&self, id: DocumentId) -> Option<u64> {
        self.store
            .tabs
            .read()
            .get(&id)
            .map(|t| t.state.lock().meta.revision)
    }

    /// Metadata for all open tabs (for a tab-list / sidebar).
    pub fn list_tabs(&self) -> Vec<DocumentMeta> {
        self.store
            .tabs
            .read()
            .values()
            .map(|t| t.state.lock().meta.clone())
            .collect()
    }

    /// Current source text of a tab (the in-memory buffer, possibly dirty).
    pub fn tab_text(&self, id: DocumentId) -> Option<String> {
        self.store
            .tabs
            .read()
            .get(&id)
            .map(|t| t.world.text())
    }

    /// Number of parent directories currently cached in the loose-resolver map.
    /// Test-only accessor for asserting cache sharing (§4.2).
    #[cfg(test)]
    pub fn loose_resolver_cache_len(&self) -> usize {
        self.store.loose_resolvers.read().len()
    }

    /// Number of out-of-workspace parent dirs currently watched by loose-file
    /// watchers. Test-only accessor for asserting watcher installation (§4.2).
    #[cfg(test)]
    pub fn loose_watcher_count(&self) -> usize {
        self.store.loose_watchers.read().len()
    }

    /// Resolve the sibling compile service (set via [`with_compile`]). Panics
    /// only if construction forgot to wire it — production wires it in
    /// [`EditorService::new`](super::editor_service::EditorService::new).
    fn compile(&self) -> Arc<CompileService> {
        self.compile
            .lock()
            .clone()
            .expect("CompileService must be wired into DocumentService before use")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::compile_status::CompileStatus;
    use crate::domain::diagnostics::Diagnostic;
    use crate::domain::document::DocumentOrigin;
    use crate::domain::source_map::LineRect;
    use crate::service::compile_service::CompileService;
    use crate::service::editor_service::Emitter;
    use crate::service::tab_store::TabStore;
    use parking_lot::Mutex;

    /// Minimal capturing emitter — only records whether a `compiled` event for
    /// `id` has been seen (enough for these service-level tests).
    struct SpyEmitter {
        compiled_ids: Mutex<Vec<DocumentId>>,
    }
    impl Emitter for SpyEmitter {
        fn emit_compiled(
            &self,
            id: DocumentId,
            _revision: u64,
            _pages: Vec<String>,
            _line_map: Vec<LineRect>,
            _duration_ms: u64,
        ) {
            self.compiled_ids.lock().push(id);
        }
        fn emit_diagnostics(&self, _id: DocumentId, _revision: u64, _d: Vec<Diagnostic>) {}
        fn emit_status(
            &self,
            _id: DocumentId,
            _revision: u64,
            _s: CompileStatus,
            _d: Option<u64>,
        ) {
        }
        fn emit_conflict(
            &self,
            _id: DocumentId,
            _revision: u64,
            _c: ConflictState,
            _d: Option<String>,
        ) {
        }
    }

    /// Build a wired pair of (DocumentService, CompileService) sharing one store,
    /// exactly as `EditorService::new` does — but exercising the services
    /// directly, not through the facade. This proves they are real, working
    /// services rather than dead shells.
    fn make_services() -> (Arc<DocumentService>, Arc<CompileService>) {
        let emitter: Arc<dyn Emitter> = Arc::new(SpyEmitter {
            compiled_ids: Mutex::new(Vec::new()),
        });
        let store = TabStore::new(emitter);
        let document = Arc::new(DocumentService::new(store.clone()));
        let compile = Arc::new(CompileService::new(store));
        document.with_compile(compile.clone());
        (document, compile)
    }

    fn wait_for_compiled(compile: &CompileService, id: DocumentId) {
        // last_doc is Some only after a compile completes and stored its result,
        // so polling it is a reliable "compile finished" signal.
        for _ in 0..60 {
            if compile.last_doc(id).is_some() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("no compiled document for {id} within timeout");
    }

    #[test]
    fn document_service_opens_and_reports_meta_directly() {
        // Exercise DocumentService WITHOUT going through EditorService: open a
        // file from content and read metadata/revision/text back through the
        // service's own accessors.
        let (document, _compile) = make_services();
        let tmp = std::env::temp_dir().join(format!("ts-docsvc-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "#set page(width: 10cm)\n\nHi").unwrap();
        let meta = document
            .open_from_content(tmp.clone(), "#set page(width: 10cm)\n\nHi".into(), None)
            .unwrap();

        // tab_meta / tab_text / tab_revision are DocumentService methods.
        let got = document.tab_meta(meta.id).expect("tab_meta via DocumentService");
        assert_eq!(got.id, meta.id);
        assert!(matches!(got.origin, DocumentOrigin::LooseFile { .. }));
        assert_eq!(document.tab_revision(meta.id), Some(0));
        assert_eq!(
            document.tab_text(meta.id).as_deref(),
            Some("#set page(width: 10cm)\n\nHi")
        );
        // list_tabs surfaces the one open document.
        assert_eq!(document.list_tabs().len(), 1);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn document_service_update_bumps_revision_and_dirty_directly() {
        // update_text is a DocumentService method: verify revision monotonicity
        // and the dirty flag flip, directly on the service.
        let (document, _compile) = make_services();
        let meta = document.new_tab(None);
        let r0 = document.tab_revision(meta.id).unwrap();
        assert!(!document.tab_meta(meta.id).unwrap().dirty);

        document.update_text(meta.id, "a".into()).unwrap();
        let r1 = document.tab_revision(meta.id).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty, "edit sets dirty");
        assert!(r1 > r0, "revision must increase");

        document.update_text(meta.id, "b".into()).unwrap();
        let r2 = document.tab_revision(meta.id).unwrap();
        assert!(r2 > r1, "revision must be strictly monotonic");
    }

    #[test]
    fn compile_service_compiles_and_reports_last_doc_directly() {
        // Exercise CompileService WITHOUT going through EditorService: open a
        // document (via DocumentService), then read compile results back through
        // CompileService's own accessors (last_doc / last_compile_state /
        // get_diagnostics).
        let (document, compile) = make_services();
        let meta = document.new_tab(Some("#set page(width: 10cm)\n\nCompile me".into()));
        wait_for_compiled(&compile, meta.id);

        // last_doc is a CompileService method — proves the compile pipeline ran
        // and stored its result on the shared tab state.
        let doc = compile
            .last_doc(meta.id)
            .expect("CompileService.last_doc should be Some after compile");
        assert!(!doc.pages().is_empty(), "compiled document must have pages");

        // last_compile_state reports the revision (0 for the initial compile)
        // and success.
        let state = compile
            .last_compile_state(meta.id)
            .expect("last_compile_state via CompileService");
        assert_eq!(state.last_compiled_revision, Some(0));
        assert!(state.success);
        assert!(state.errors.is_empty());

        // get_diagnostics is empty on a clean compile.
        assert!(compile.get_diagnostics(meta.id).is_empty());

        // compile_now runs synchronously and the result is still queryable.
        compile.compile_now(meta.id);
        assert!(compile.last_doc(meta.id).is_some());
    }

    #[test]
    fn compile_service_reports_diagnostics_for_failing_source() {
        let (document, compile) = make_services();
        let meta = document.new_tab(None);
        document.update_text(meta.id, "#assert(false)\n".into()).unwrap();
        // Wait for the worker to land the failing compile.
        for _ in 0..40 {
            if !compile.get_diagnostics(meta.id).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let diags = compile.get_diagnostics(meta.id);
        assert!(!diags.is_empty(), "failing source must surface diagnostics via CompileService");
        let state = compile.last_compile_state(meta.id).expect("state present");
        assert!(!state.success, "compile state must report failure");
    }
}
