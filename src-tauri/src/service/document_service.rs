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
use crate::persistence::recovery::RecoveryService;
use crate::render::outline::build_outline;
use crate::render::source_map::build_source_map;
use crate::render::svg::SvgRenderer;
use crate::typst_engine::world::EditorWorld;

use super::compile_service::CompileService;
use super::tab_state::TabState;
use super::tab_store::{
    classify_new, find_existing, handle_external_change_locked, loose_resolver_for,
    loose_watcher_for, reclassified_origin, resolver_for_origin, set_conflict, TabStore,
};
use super::workspace_service::WorkspaceService;

/// Default content for a fresh untitled tab.
const DEFAULT_TEMPLATE: &str = "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

/// One successfully rebound document from a rename/move (§6.4). Returned by
/// [`DocumentService::rebind_for_rename`] so the IPC layer can emit per-doc
/// path-change events for the frontend (tab title, breadcrumb, active-file
/// highlight all derive from the new path).
#[derive(Debug, Clone)]
pub struct ReboundDoc {
    /// The (stable) document id.
    pub id: DocumentId,
    /// The pre-rename canonical path.
    pub old_path: PathBuf,
    /// The post-rename canonical path.
    pub new_path: PathBuf,
}

/// One open document at/under a path of interest (§5.5). Returned by the
/// docs-under-path queries; the IPC delete command inspects
/// `dirty` to decide whether to block (§5.5 "dirty 文档存在时阻止删除").
#[derive(Debug, Clone)]
pub struct AffectedDoc {
    /// The document id.
    pub id: DocumentId,
    /// The document's canonical path (== prefix or under it).
    pub path: PathBuf,
    /// Whether the document has unsaved edits.
    pub dirty: bool,
    /// Whether the document is already in an unresolved disk-conflict state.
    pub conflict: ConflictState,
}

/// One WorkspaceFile tab's state as snapshotted for a world rebuild in
/// [`DocumentService::rebuild_workspace_worlds`]. The CAS loop compares
/// `meta.revision` + `text` against the live tab before swapping in the
/// rebuilt world, so an edit landing between snapshot and swap is retried
/// against instead of being overwritten.
struct WorkspaceTabSnapshot {
    meta: DocumentMeta,
    text: String,
    disk_version: Option<DiskVersion>,
    file_identity: crate::domain::disk_version::FileIdentity,
    canon: PathBuf,
}

/// Outcome of a compare-and-swap text replacement
/// ([`DocumentService::replace_text_cas`](Self::replace_text_cas)).
///
/// Serialized for the IPC layer: an `Applied` tells the caller its computed
/// content landed at `revision`; a `Conflated` tells it the buffer moved
/// underneath it and hands back the fresh state to recompute against.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CasReplaceOutcome {
    /// The buffer held exactly the expected text at the observed revision;
    /// the new content was applied and the buffer is now at `revision`
    /// (observed revision + 1).
    Applied {
        /// The post-apply buffer revision.
        revision: u64,
    },
    /// The buffer's text and/or revision moved since the caller observed it;
    /// NOTHING was written. Carries the FRESH current text + revision so the
    /// caller can recompute its edit against them and retry.
    Conflated {
        /// The buffer's current text (never the caller's stale copy).
        text: String,
        /// The buffer's current revision.
        revision: u64,
    },
}

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
    /// Crash-recovery snapshot sink (§5.1). `None` in tests / when recovery is
    /// disabled. Wired after construction via [`set_recovery`](Self::set_recovery).
    recovery: Mutex<Option<Arc<RecoveryService>>>,
}

fn canonicalize_existing_or_target(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return canonicalize_for_identity(path);
    }
    if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
        if parent.exists() {
            let mut parent = canonicalize_for_identity(parent)?;
            parent.push(file_name);
            return Ok(parent);
        }
    }
    canonicalize_for_identity(path)
}

impl DocumentService {
    /// Construct a document service over a fresh shared store.
    pub fn new(store: TabStore) -> Self {
        Self {
            store,
            compile: Mutex::new(None),
            recovery: Mutex::new(None),
        }
    }

    /// Wire the sibling compile service, used for worker rotation when a
    /// document's origin changes. Call once after both services are built.
    pub fn with_compile(&self, compile: Arc<CompileService>) {
        *self.compile.lock() = Some(compile);
    }

    /// Wire the crash-recovery service (§5.1). `None` leaves recovery disabled
    /// (the test paths and any "recovery off" future toggle). Call once after
    /// the recovery service is built in `.setup`.
    pub fn set_recovery(&self, recovery: Arc<RecoveryService>) {
        *self.recovery.lock() = Some(recovery);
    }

    /// Snapshot the recovery handle (if wired), for the IPC/flush paths.
    pub fn recovery(&self) -> Option<Arc<RecoveryService>> {
        self.recovery.lock().clone()
    }

    /// Read-only access to the document registry (for the IPC layer to detect
    /// "already open" before creating a duplicate).
    pub fn registry(&self) -> &SharedRegistry {
        self.store.registry()
    }

    /// A clone of the shared backing store. Used by the watcher-health polling
    /// fallback (§6.3) to enumerate open docs + route divergences through the
    /// shared external-change handler. The store is `Clone` (all-`Arc` fields),
    /// so this is cheap and shares the same underlying maps.
    pub fn store_clone(&self) -> TabStore {
        self.store.clone()
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
            // §B1 dedup invariant: reopening a soft-closed (hidden) file makes
            // it visible again. find_existing returns the meta as-is (the
            // registry carries the `hidden` flag), so a hidden doc would be
            // handed back with hidden == true and the caller (openPath) would
            // leave it in BOTH the visible tabs list AND the hidden list.
            // Flip the flag to visible here (idempotent for an already-visible
            // doc) so the returned meta is consistent.
            self.set_visibility(existing.id, false);
            // Replay the cached compile as a full payload: after a webview
            // reload the frontend's preview state is fresh, and the next
            // incremental compile (full=false, backend cache matches the page
            // count) would leave undefined holes in its page array. Mirrors
            // `reactivate`; no-op when nothing is cached.
            self.replay_cached_compiled(existing.id);
            return Ok(self.tab_meta(existing.id).unwrap_or(existing));
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
    /// [`open_from_content`](Self::open_from_content) — historically a
    /// byte-identical twin of that method; now a pure delegation so the dedup
    /// / registration / worker / watcher pipeline exists exactly once.
    pub fn open_from_disk(
        &self,
        path: PathBuf,
        content: String,
        workspace: Option<&WorkspaceService>,
    ) -> Result<DocumentMeta> {
        self.open_from_content(path, content, workspace)
    }

    /// Open a **non-Typst** tab backed by a real file on disk — an image or
    /// PDF previewed in-app, or a plain-text/markdown file edited without the
    /// Typst compile pipeline.
    ///
    /// Unlike [`open_from_disk`](Self::open_from_disk), this path:
    /// - skips compile-worker creation (no `compile().create_worker`), so the
    ///   backend never tries to compile a `.pdf`/`.png`/`.md` as Typst;
    /// - skips VFS publishing and relative-resource resolution — non-Typst
    ///   documents are not `#include` targets;
    /// - for binary kinds ([`DocumentKind::is_binary_preview`]) does NOT read
    ///   the bytes at all: the caller passes an empty `content` and the
    ///   frontend fetches bytes on demand via `read_file_bytes`.
    ///
    /// For editable non-Typst text kinds (txt/md/json/...) the caller passes
    /// the file's text as `content` so the buffer is editable; the only thing
    /// skipped relative to Typst is compile/LSP/VFS.
    ///
    /// `kind` is stamped onto the meta so the frontend can dispatch to the
    /// right viewer/editor. Dedup is by canonical path, identical to the Typst
    /// open path (reopening focuses the existing tab).
    pub fn open_non_typst_from_disk(
        &self,
        path: PathBuf,
        kind: crate::domain::document::DocumentKind,
        content: String,
        workspace: Option<&WorkspaceService>,
    ) -> Result<DocumentMeta> {
        debug_assert!(
            !kind.is_typst(),
            "open_non_typst_from_disk is for non-Typst kinds; use open_from_disk for Typst"
        );
        let canon = canonicalize_for_identity(&path)?;
        if let Some(existing) = find_existing(&self.store, &canon) {
            // §B1 dedup invariant: a soft-closed (hidden) doc must be made
            // visible on reopen (same as the Typst open path).
            self.set_visibility(existing.id, false);
            return Ok(self.tab_meta(existing.id).unwrap_or(existing));
        }
        let meta = classify_new(DocumentId::new(), canon.clone(), workspace).with_kind(kind);
        let id = meta.id;
        self.store.registry.write().register(meta.clone())?;
        // A non-Typst tab still needs a TabState (for meta + dirty + the text
        // buffer of editable kinds). The detached world (no resolver) is fine:
        // these documents are never compiled, so the world is just a text
        // container.
        let tab = Arc::new(TabState::with_meta(meta.clone(), content));
        self.store.tabs.write().insert(id, tab);
        // Seed the disk version so external-change detection still works for
        // editable text kinds (md/txt). For binary kinds the version is
        // harmless (the frontend never writes), but we set it for uniformity.
        self.set_disk_version_from_path(id, meta.origin.canonical_path());
        self.ensure_dir_watched(id, &meta.origin, workspace);
        // NOTE: deliberately NO compile().create_worker() and NO sync_vfs_for()
        // — non-Typst documents do not compile and are not VFS-published.
        Ok(meta)
    }

    /// Clone the [`Arc<TabState>`] handle for an open tab, or fail with the
    /// canonical `NotFound` message if it isn't open. Shared prologue of every
    /// method that needs the tab handle outside the tabs lock; centralizing it
    /// keeps the NotFound contract (message + code) from drifting per-site.
    fn tab_cloned(&self, id: DocumentId) -> Result<Arc<TabState>> {
        self.store
            .tabs
            .read()
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))
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

    /// Seed (or refresh) a tab's [`DiskVersion`] AND [`FileIdentity`] from its
    /// on-disk file (§8.4 / §5.4). Best-effort: if the file can't be read
    /// (untitled / deleted mid-open), the version is left as-is. Called on open
    /// and after Save As rebind. The inode (`FileIdentity`) is always captured
    /// best-effort (UNKNOWN when unavailable) so the `Replaced` conflict check
    /// has a baseline to compare against on the next external change.
    fn set_disk_version_from_path(&self, id: DocumentId, path: Option<&Path>) {
        let Some(path) = path else { return };
        let Ok(version) = DiskVersion::from_path(path) else {
            return;
        };
        let identity = crate::domain::disk_version::FileIdentity::from_path(path);
        if let Some(t) = self.store.tabs.read().get(&id) {
            let mut rt = t.state.lock();
            rt.disk_version = Some(version);
            rt.file_identity = identity;
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
        self.drop_vfs_for_canon(&canon);
    }

    /// The VFS/dependency teardown for a KNOWN canonical path — shared by
    /// [`drop_vfs_for`](Self::drop_vfs_for) (tab still in the map) and
    /// [`hard_close_if_clean`](Self::hard_close_if_clean) (tab already
    /// removed under the close's write lock, canon captured beforehand —
    /// `drop_vfs_for` can no longer resolve it there).
    fn drop_vfs_for_canon(&self, canon: &Path) {
        self.store.vfs.remove(canon);
        // Drop this document's outgoing dependency edges too: a closed tab no
        // longer includes anything. (Ingoing edges — others depending on this
        // file — are kept; the file still exists on disk.)
        self.store.deps.remove_outgoing(canon);
        // Cascade a recompile so documents that #include this file fall back to
        // the disk copy now that its live buffer left the VFS overlay.
        self.recompile_dependents_of(canon);
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
    ///
    /// `saved_revision` is the revision whose text was just written. The dirty
    /// flag is cleared only when the tab's CURRENT revision still equals
    /// `saved_revision` — a compare-and-set that prevents a lost-update race
    /// where an `update_text` lands between the write completing and this call
    /// (that edit's dirty flag must NOT be clobbered). If the revision advanced
    /// (the user typed during the save), dirty stays true and the recovery
    /// snapshot is kept (the new unsaved edit is still recoverable).
    ///
    /// The conflict flag, by contrast, is cleared **unconditionally**: a
    /// successful write means the disk now matches what we just wrote, so any
    /// prior external-change conflict is resolved regardless of a racing edit.
    /// This is what lets `save_overwrite` (the user's explicit "overwrite disk"
    /// action) clear a `Modified`/`Replaced` conflict even when a keystroke
    /// lands during the write — without it, the stale conflict would block the
    /// next in-place save at the conflict gate.
    pub fn mark_saved(&self, id: DocumentId, saved_revision: u64) {
        let (path, still_clean) = {
            let tabs = self.store.tabs.read();
            let Some(tab) = tabs.get(&id) else { return };
            let mut rt = tab.state.lock();
            // CAS: only clear dirty/conflict when the buffer hasn't advanced
            // past the saved revision. If an `update_text` landed between the
            // write completing and this call, that newer edit is still unsaved
            // — its dirty flag must NOT be clobbered (lost-update guard).
            // CAS: only clear `dirty` when the buffer hasn't advanced past the
            // saved revision. If an `update_text` landed between the write
            // completing and this call, that newer edit is still unsaved — its
            // dirty flag must NOT be clobbered (lost-update guard).
            let still_clean = rt.meta.revision == saved_revision;
            if still_clean {
                rt.meta.dirty = false;
            } else {
                tracing::debug!(
                    ?id, saved_revision, current = rt.meta.revision,
                    "mark_saved: revision advanced during save; keeping dirty"
                );
            }
            // The conflict flag is cleared UNCONDITIONALLY. A successful write
            // means the disk now matches the buffer we just wrote, so any prior
            // external-change conflict is resolved — whether or not the buffer
            // has since advanced. This matters for `save_overwrite` (the user's
            // explicit "overwrite disk" action): a keystroke landing during the
            // write must NOT leave a stale conflict that would block the next
            // in-place save at the conflict gate. `dirty` stays CAS-gated (the
            // newer edit is unsaved), but `conflict` (an *external* divergence)
            // is not. (Regular `save` never reaches here with an active conflict
            // — the gate rejects it — so this only affects save_overwrite, where
            // it is correct.)
            rt.meta.conflict = ConflictState::None;
            (
                rt.meta.origin.canonical_path().map(|p| p.to_path_buf()),
                still_clean,
            )
        };
        // ALWAYS re-baseline the disk version + identity from the bytes the
        // caller just wrote — even when the buffer has since advanced. The
        // bytes on disk are exactly `saved_revision`'s content regardless, so
        // the stored version must reflect that, or the next watcher event /
        // WatcherHealth poll would see stored V0 ≠ disk V1 and spuriously
        // report a `Modified` conflict for our own save. (Previously this ran
        // only on the CAS-pass branch, which tripped "file changed on disk"
        // any time a keystroke's `update_text` landed between the atomic write
        // and this call — a race that's easy to hit with autosave or saving
        // mid-typing.) Reads outside the lock (no nested cross-service locks).
        if let Some(path) = path {
            self.set_disk_version_from_path(id, Some(&path));
        }
        // The recovery snapshot is disposable only once the buffer is fully
        // clean on disk. When dirty is retained (buffer advanced past the
        // saved revision), keep the snapshot so the unsaved edit stays
        // recoverable. Best-effort: no recovery service wired → no-op.
        if still_clean {
            if let Some(recovery) = self.recovery() {
                recovery.discard_snapshot(id);
            }
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
    /// - **content differs** (clean or dirty buffer) → `ConflictState::Modified`
    ///   carrying the new disk version + current disk content; buffer untouched;
    ///   conflict event emitted. The frontend surfaces the conflict and asks the
    ///   user whether to apply the disk content; resolving via
    ///   [`resolve_conflict_use_disk`][Self::resolve_conflict_use_disk] then
    ///   performs the reload (set world text, bump revision, clear dirty/conflict,
    ///   update disk version) and recompiles.
    ///
    /// The app's OWN save is recognized because [`mark_saved`] updates the
    /// stored version to match the freshly-written bytes, so the watcher event
    /// for that write compares equal → no-op (the "content identical" case).
    pub fn handle_external_change(&self, path: &Path) {
        handle_external_change_locked(
            path,
            &self.store.tabs,
            &self.store.registry,
            &self.store.emitter,
        );
        // Cascade a recompile to open documents that transitively #include this
        // path (multi-file projects). Covers two cases the conflict-detection
        // above ignores: (a) `path` isn't itself an open document but IS
        // included by one (its disk content changed), and (b) `path` is an open
        // document whose buffer the user keeps — dependents compile against the
        // live VFS overlay either way. Self-induced save events are coalesced
        // by the worker (content-identical → same result), so this is harmless.
        self.recompile_dependents_of(path);
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
    /// Unlike the Phase 1 path-only assignment (which only updated
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
        self.rebind_path_inner(id, target_path, None)
    }

    /// Rebind after a successful Save As write. The tab is clean only when the
    /// buffer revision still matches the snapshot that was written.
    pub fn rebind_path_after_save(
        &self,
        id: DocumentId,
        target_path: PathBuf,
        saved_revision: u64,
    ) -> Result<()> {
        self.rebind_path_inner(id, target_path, Some(saved_revision))
    }

    fn rebind_path_inner(
        &self,
        id: DocumentId,
        target_path: PathBuf,
        saved_revision: Option<u64>,
    ) -> Result<()> {
        let canon = canonicalize_for_identity(&target_path)?;
        let root = canon
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // Snapshot the current buffer + revision + old canonical path before
        // mutating anything, so a registry conflict leaves the tab fully intact.
        let (text, revision, old_canon, current_meta) = {
            let tabs = self.store.tabs.read();
            let tab = tabs
                .get(&id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("tab {id} not found")))?;
            let rt = tab.state.lock();
            let meta = rt.meta.clone();
            (
                tab.world.text(),
                meta.revision,
                meta.origin.canonical_path().map(|p| p.to_path_buf()),
                meta,
            )
        };

        // New metadata: loose file at the target, revision carried over.
        // `dirty`:
        // - Save As (`saved_revision: Some`): the tab is clean iff the buffer
        //   revision still matches the snapshot that was written — a racing
        //   newer edit stays dirty (the written bytes are stale for it).
        // - Generic rebind (`saved_revision: None`, i.e. the rename 联动):
        //   the buffer did NOT hit disk, so
        //   the CURRENT dirty flag must carry over. Resetting it here would
        //   silently un-dirty a doc with unsaved edits — delete protection
        //   (`docs_under_path_with_hidden` / `hard_close_if_clean` reads
        //   `meta.dirty`) would then destroy the unsaved buffer without the
        //   §5.5 DeleteBlocked prompt, and recovery snapshotting
        //   (`snapshot_dirty_documents` filters on `meta.dirty`) would skip
        //   it. `kind`, `conflict`, and `hidden` are preserved from the
        //   CURRENT meta for the same reason: a directory rename rebinds
        //   every open doc under the prefix, including non-Typst tabs
        //   (image / pdf / markdown, opened via `open_non_typst_from_disk`,
        //   which deliberately skip the compile pipeline) and soft-closed
        //   (hidden) ones — resetting those flags here would flip a non-Typst
        //   tab back to Typst (spawning a compile worker for a non-Typst
        //   buffer), drop an active conflict, and un-hide a soft-closed tab.
        let new_meta = DocumentMeta {
            dirty: saved_revision.map_or(current_meta.dirty, |saved| saved != revision),
            revision,
            kind: current_meta.kind,
            conflict: current_meta.conflict,
            hidden: current_meta.hidden,
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
                // The Save-As target is a different file; drop the old path's
                // outgoing dependency edges. The new path's edges refresh on the
                // imminent recompile (swap_world → create_worker → compile).
                self.store.deps.remove_outgoing(old);
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

    /// Snapshot revision and text under the same state -> world lock order used
    /// by edits and compiles.
    pub fn snapshot_for_save(&self, id: DocumentId) -> Result<(u64, String)> {
        let tab = self.tab_cloned(id)?;
        let rt = tab.state.lock();
        Ok((rt.meta.revision, tab.world.text()))
    }

    /// Reject a Save As target owned by another open document before touching
    /// the target on disk.
    pub fn ensure_rebind_target_available(&self, id: DocumentId, target: &Path) -> Result<()> {
        let canon = canonicalize_for_identity(target)?;
        if let Some(existing_id) = self.store.registry.read().find_by_canonical(&canon) {
            if existing_id != id {
                return Err(AppError::AlreadyOpen {
                    existing_id,
                    path: canon.to_string_lossy().into_owned(),
                });
            }
        }
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
    /// Non-Typst documents skip the worker rotation: they never have a compile
    /// worker (see [`open_non_typst_from_disk`](Self::open_non_typst_from_disk)),
    /// and spawning one would try to compile an image / pdf / markdown buffer.
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
        self.rotate_worker_if_typst(id, &new_tab);
    }

    /// Worker-rotation tail shared by [`swap_world`](Self::swap_world) and
    /// [`cas_swap_world`](Self::cas_swap_world): drop the old worker and spawn
    /// a fresh one that signals an immediate recompile — but ONLY for Typst
    /// documents. Non-Typst tabs (image / pdf / markdown) deliberately skip
    /// the compile pipeline, so a world rebuild for them must not spawn a
    /// compile worker.
    fn rotate_worker_if_typst(&self, id: DocumentId, tab: &Arc<TabState>) {
        if !tab.state.lock().meta.kind.is_typst() {
            return;
        }
        let _ = self.store.workers.write().remove(&id);
        self.compile().create_worker(id, tab.clone());
    }

    /// Collect every open document whose canonical path equals or sits under
    /// `prefix` (§5.5 dirty-delete check + §6.4 rename 联动 share this scan).
    /// Returns `(id, canonical_path, dirty)` for each, so the caller can decide
    /// what to do — the IPC delete command blocks when any is dirty; the rename
    /// command rebinds all of them.
    ///
    /// `prefix` is canonicalized via [`canonicalize_for_identity`] so the
    /// comparison is against the same canonical form the docs store (on macOS,
    /// `/var/...` resolves to `/private/var/...` — without canonicalizing the
    /// prefix, a `/var`-rooted path would never match a `/private/var`-rooted
    /// doc). Best-effort: a non-canonicalizable prefix yields an empty result.
    ///
    /// Untitled documents carry no canonical path and are never affected.
    ///
    /// Soft-closed (hidden) documents are intentionally EXCLUDED: the user has
    /// dismissed them from the tab strip, so from their perspective the file is
    /// no longer "open". Counting a hidden tab here would let a stale hidden
    /// doc (e.g. one carrying an unresolved conflict) block deletes/overwrites
    /// forever, even though the user believes they closed it. The hidden tab's
    /// state survives for zero-cost reactivate (§B2) and is naturally reclaimed
    /// when LRU hard-closes it.
    #[cfg(test)]
    pub fn docs_under_path(&self, prefix: &Path) -> Vec<AffectedDoc> {
        self.docs_under_path_impl(prefix, false)
    }

    /// Like `docs_under_path` (visible-only) but ALSO includes
    /// soft-closed (hidden) documents. Used by the DELETE flow
    /// (`delete_entry` / `delete_entry_permanent`): once the backing file is
    /// trashed, a hidden tab for it is a zombie — its reactivate-on-demand
    /// promise can never be honored (the file is gone), so a CLEAN hidden doc
    /// is hard-closed alongside the visible ones and its id returned in
    /// `closed_doc_ids` (the frontend's removeDocFromStores filters the hidden
    /// list too). A DIRTY hidden doc still holds unsaved edits the user parked
    /// in the background, so it must BLOCK the delete exactly like a dirty
    /// visible doc — silently trashing its buffer would lose those edits.
    ///
    /// The template-overwrite preflight keeps using
    /// [`docs_at_paths`](Self::docs_at_paths) (visible-only) — see its docs.
    pub fn docs_under_path_with_hidden(&self, prefix: &Path) -> Vec<AffectedDoc> {
        self.docs_under_path_impl(prefix, true)
    }

    /// Shared body of the docs-under-path queries. `include_hidden` selects
    /// between the visible-only and with-hidden policies (see the two public
    /// wrappers above for their rationales).
    fn docs_under_path_impl(&self, prefix: &Path, include_hidden: bool) -> Vec<AffectedDoc> {
        // Canonicalize the prefix once so the per-doc comparison is in the same
        // form as the docs' stored canonical paths.
        let canon_prefix = match canonicalize_for_identity(prefix) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        let tabs = self.store.tabs.read();
        tabs.values()
            .filter_map(|t| {
                let rt = t.state.lock();
                if !include_hidden && rt.meta.hidden {
                    return None;
                }
                let canon = rt.meta.origin.canonical_path()?.to_path_buf();
                if canon == canon_prefix || canon.starts_with(&canon_prefix) {
                    Some(AffectedDoc {
                        id: rt.meta.id,
                        path: canon,
                        dirty: rt.meta.dirty,
                        conflict: rt.meta.conflict,
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    /// Collect every open document whose canonical path exactly matches one of
    /// `paths`. App-initiated writes use this to preflight template application
    /// before the disk is changed and before the watcher reports a surprising
    /// external modification.
    ///
    /// Soft-closed (hidden) documents are excluded — see `docs_under_path`'s
    /// rationale above.
    pub fn docs_at_paths(&self, paths: &[PathBuf]) -> Vec<AffectedDoc> {
        self.docs_at_paths_impl(paths, false)
    }

    /// Like [`docs_at_paths`](Self::docs_at_paths) but ALSO includes
    /// soft-closed (hidden) documents. Used by search-replace: a hidden tab
    /// still holds a live (possibly dirty) buffer in memory, so its content
    /// must be spliced from that buffer and written back via `update_text` —
    /// NOT from disk (which would silently discard its unsaved edits). The
    /// template/delete paths keep using `docs_at_paths` (visible tabs only).
    pub fn docs_at_paths_with_hidden(&self, paths: &[PathBuf]) -> Vec<AffectedDoc> {
        self.docs_at_paths_impl(paths, true)
    }

    /// Shared body of the docs-at-paths queries. `include_hidden` selects
    /// between the visible-only and with-hidden policies (see the two public
    /// wrappers above for their rationales).
    fn docs_at_paths_impl(&self, paths: &[PathBuf], include_hidden: bool) -> Vec<AffectedDoc> {
        use std::collections::HashSet;

        let targets: HashSet<PathBuf> = paths
            .iter()
            .filter_map(|p| canonicalize_existing_or_target(p).ok())
            .collect();
        if targets.is_empty() {
            return Vec::new();
        }

        let tabs = self.store.tabs.read();
        tabs.values()
            .filter_map(|t| {
                let rt = t.state.lock();
                if !include_hidden && rt.meta.hidden {
                    return None;
                }
                let canon = rt.meta.origin.canonical_path()?.to_path_buf();
                if targets.contains(&canon) {
                    Some(AffectedDoc {
                        id: rt.meta.id,
                        path: canon,
                        dirty: rt.meta.dirty,
                        conflict: rt.meta.conflict,
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    /// Rebind every open document whose canonical path equals or sits under
    /// `from_prefix` to the matching path under `to_prefix` (§6.4 file-op
    /// 联动). Called by the IPC [`rename_entry`](crate::ipc::fs_commands::rename_entry)
    /// command AFTER the disk rename has succeeded, so each affected open doc is
    /// moved to its new canonical location in lockstep with the file on disk.
    ///
    /// A rename/move affects:
    /// - the renamed file itself, when `from` is a file (its single open doc);
    /// - every open doc inside a renamed directory, when `from` is a dir
    ///   (`from_prefix`/`to_prefix` substitution rewrites each child path).
    ///
    /// Each affected doc is rebound via [`rebind_path`](Self::rebind_path) (the
    /// same path Save As uses): registry rebind, world rebuild anchored at the
    /// new parent, VFS re-key, worker rotate, disk-version reseed. The doc keeps
    /// its [`DocumentId`], buffer, and revision.
    ///
    /// # Transactionality (§6.4)
    ///
    /// The disk rename happens first (in [`WorkspaceService::rename_entry`]); if
    /// it succeeds, the rebinds follow. A rebind can only fail on a registry
    /// conflict at the new path (another open doc already bound there) — rare,
    /// but possible if the user has the destination open. On such a failure we
    /// do NOT abort the whole rename (the disk already moved); instead the
    /// offending doc is left pointing at its old (now-vanished) path and the
    /// watcher will mark it [`ConflictState::Missing`] on the next flush,
    /// giving the user a recoverable state. Other affected docs are still
    /// rebound. A full 2-phase commit is out of scope (§6.4 allows "进入明确的
    /// recoverable 状态").
    ///
    /// # Watcher race during rebind
    ///
    /// The disk rename fires watcher events for the old-path deletion and
    /// new-path creation. During this window `handle_external_change` may run
    /// concurrently with the rebind loop. This is safe: the old-path deletion
    /// event on a not-yet-rebound doc marks it `Missing` (the intended end
    /// state if rebind were to fail); the new-path creation event finds no doc
    /// (registry still keyed at the old path until rebind) — a no-op. After
    /// rebind completes the doc is keyed at the new path and self-save events
    /// there resolve correctly. No correctness bug; the ordering is subtle.
    ///
    /// Returns the list of docs that were successfully rebound (`(id,
    /// old_path, new_path)`), so the IPC layer can emit per-doc path-change
    /// events for the frontend.
    pub fn rebind_for_rename(
        &self,
        from_prefix: &Path,
        to_prefix: &Path,
    ) -> Vec<ReboundDoc> {
        // Canonicalize `from_prefix` so the comparison matches the docs' stored
        // canonical paths. After the disk rename the source no longer exists, so
        // `canonicalize_for_identity` falls back to lexical normalization (which
        // is correct for a workspace-rooted path — the workspace root is already
        // canonical, so `<root>/<rel>` matches the doc's canonical path even when
        // the leaf doesn't exist). Best-effort: a non-canonicalizable prefix
        // yields an empty result (no docs rebound).
        let canon_from = match canonicalize_for_identity(from_prefix) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        // Snapshot the affected docs (id + canonical path) under a brief read
        // lock, then rebind each OUTSIDE the lock (rebind_path takes its own
        // locks + spawns a worker). Filtering by canonical-path prefix catches
        // both the file itself and (for a dir) every open child.
        let affected: Vec<(DocumentId, PathBuf)> = {
            let tabs = self.store.tabs.read();
            tabs.values()
                .filter_map(|t| {
                    let rt = t.state.lock();
                    let canon = rt.meta.origin.canonical_path()?.to_path_buf();
                    if canon == canon_from || canon.starts_with(&canon_from) {
                        Some((rt.meta.id, canon))
                    } else {
                        None
                    }
                })
                .collect()
        };

        let mut rebound = Vec::new();
        // Canonicalize `to_prefix` once so prefix substitution is consistent with
        // the canonicalized `from` side. After the disk rename the target exists,
        // so `canonicalize_for_identity` resolves symlinks; on failure fall back
        // to the raw `to_prefix` (lexical) — still correct when the workspace
        // root is already canonical (the common case).
        let canon_to = canonicalize_for_identity(to_prefix).unwrap_or_else(|_| to_prefix.to_path_buf());
        for (id, old_canon) in affected {
            // Compute the new canonical path by substituting the prefix.
            // Strip the CANONICAL `from` prefix (not the raw `from_prefix`) so the
            // strip matches the `starts_with(canon_from)` filter above even if a
            // caller passed a non-normalized `from_prefix`. Re-attach under the
            // canonical `to_prefix`.
            let tail = old_canon.strip_prefix(&canon_from).ok();
            let new_canon = match tail {
                Some(tail) if !tail.as_os_str().is_empty() => canon_to.join(tail),
                _ => canon_to.clone(),
            };
            // rebind_path rebuilds the world anchored at the new parent + reseeds
            // the disk version. It only errors on a registry conflict at the new
            // path; on that rare conflict, log + leave the doc pointing at the
            // (now-vanished) old path so the watcher surfaces Missing (§6.4).
            match self.rebind_path(id, new_canon.clone()) {
                Ok(()) => rebound.push(ReboundDoc {
                    id,
                    old_path: old_canon,
                    new_path: new_canon,
                }),
                Err(e) => {
                    tracing::warn!(
                        "rebind_for_rename: could not rebind doc {id} from \
                         {old_canon:?} to {new_canon:?}: {e}; leaving it at the \
                         old path (watcher will mark Missing)"
                    );
                }
            }
        }
        rebound
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

    /// Force-rebuild the `EditorWorld` of every WorkspaceFile tab against the
    /// workspace resolver's CURRENT root. Used when `[compile].root` changes:
    /// [`reclassify_documents`](Self::reclassify_documents) would skip these
    /// because their origin is unchanged, but each tab's main `FileId` vpath was
    /// virtualized against the now-stale root, so includes/images/reads would
    /// silently resolve to the wrong disk path until the tab is reopened. Like
    /// `reclassify_one`, the disk_version + file_identity are carried across the
    /// rebuild (the file itself didn't change — only its resolution anchor did).
    ///
    /// ## Snapshot→swap race (CAS)
    ///
    /// This runs on the watcher thread right after an external `.typstpro`
    /// edit — i.e. at the exact moment the user may be typing. The world build
    /// is expensive and runs OUTSIDE any lock, so an [`apply_text`](Self::apply_text)
    /// can land between the snapshot and the tab insert; inserting the new tab
    /// built from the OLD text/revision would silently discard that edit. The
    /// loop below is a bounded compare-and-swap: snapshot under the state lock
    /// → build → re-verify (revision AND text unchanged) under the same lock,
    /// atomically with the insert → on mismatch, retry from a fresh snapshot.
    /// Bounded: if the buffer keeps advancing through every attempt (user
    /// typing furiously), the swap is skipped with a warn — a stale resolution
    /// anchor until the next rebuild is annoying, a lost edit is not.
    pub fn rebuild_workspace_worlds(&self, ws: &WorkspaceService) {
        let Some(resolver) = ws.resolver() else { return; };
        let ids: Vec<DocumentId> = self.store.tabs.read().keys().copied().collect();
        const MAX_ATTEMPTS: usize = 4;
        for id in ids {
            let mut eligible = false;
            let mut swapped = false;
            for _attempt in 0..MAX_ATTEMPTS {
                let Some(snap) = self.snapshot_workspace_tab(id) else {
                    // Not a WorkspaceFile / untitled / already closed: nothing
                    // to rebuild (the normal case for most tabs — not an error).
                    break;
                };
                eligible = true;
                let new_tab =
                    self.build_tab(&snap.meta, &snap.text, Some(resolver.clone()), &snap.canon);
                if self.cas_swap_world(id, &snap, new_tab) {
                    // Restore the disk_version AND file_identity (the rebuild
                    // reset both to None / UNKNOWN; the file is unchanged, so
                    // the snapshot's values are still accurate).
                    if let Some(dv) = snap.disk_version {
                        if let Some(t) = self.store.tabs.read().get(&id) {
                            let mut rt = t.state.lock();
                            rt.disk_version = Some(dv);
                            rt.file_identity = snap.file_identity;
                        }
                    }
                    swapped = true;
                    break;
                }
                // CAS failed: the buffer advanced since the snapshot — retry
                // from a fresh one so the rebuilt world carries the newest text.
            }
            if eligible && !swapped {
                tracing::warn!(
                    ?id,
                    attempts = MAX_ATTEMPTS,
                    "compile-root rebuild kept losing the CAS race with edits; \
                     leaving the tab on its old-resolution world (no edit lost)"
                );
            }
        }
    }

    /// Snapshot one WorkspaceFile tab for a world rebuild (see
    /// [`rebuild_workspace_worlds`](Self::rebuild_workspace_worlds)). `None`
    /// when the tab is gone, untitled, or not workspace-anchored (nothing to
    /// rebuild for those).
    fn snapshot_workspace_tab(&self, id: DocumentId) -> Option<WorkspaceTabSnapshot> {
        let tabs = self.store.tabs.read();
        let tab = tabs.get(&id).cloned()?;
        let rt = tab.state.lock();
        // Only WorkspaceFile tabs are anchored at the workspace resolver —
        // LooseFile/Untitled tabs are unaffected by a compile-root move.
        if !matches!(rt.meta.origin, DocumentOrigin::WorkspaceFile { .. }) {
            return None;
        }
        let canon = rt.meta.origin.canonical_path()?.to_path_buf();
        Some(WorkspaceTabSnapshot {
            meta: rt.meta.clone(),
            text: tab.world.text(),
            disk_version: rt.disk_version,
            file_identity: rt.file_identity,
            canon,
        })
    }

    /// Compare-and-swap tail of [`rebuild_workspace_worlds`](Self::rebuild_workspace_worlds):
    /// under the tabs write + state locks, verify the doc's buffer still
    /// matches `snap` (revision AND text — text equality additionally covers
    /// `apply_text`'s same-revision replacement path) and only then insert
    /// `new_tab`. Returns `false` when the buffer advanced (caller retries
    /// with a fresh snapshot); `true` when the swap happened or the tab had
    /// already closed (nothing left to swap).
    ///
    /// Lock order (tabs → state) matches every other TabStore user; the
    /// worker rotation runs after the write guard is released, mirroring
    /// [`swap_world`](Self::swap_world).
    fn cas_swap_world(
        &self,
        id: DocumentId,
        snap: &WorkspaceTabSnapshot,
        new_tab: Arc<TabState>,
    ) -> bool {
        {
            let mut tabs = self.store.tabs.write();
            let Some(tab) = tabs.get(&id) else {
                // Closed mid-rebuild (user or LRU): nothing to swap, and
                // nothing was lost — treat as handled.
                return true;
            };
            let rt = tab.state.lock();
            if rt.meta.revision != snap.meta.revision || tab.world.text() != snap.text {
                return false; // CAS miss: an edit landed since the snapshot.
            }
            drop(rt);
            tabs.insert(id, new_tab.clone());
        }
        // Same worker-rotation tail as `swap_world` (old worker dropped, fresh
        // one signals an immediate recompile against the rebuilt world;
        // non-Typst tabs skip it).
        self.rotate_worker_if_typst(id, &new_tab);
        true
    }

    /// Reclassify a single document, if its origin should change under `ws`.
    /// No-op when the origin is already correct (or the doc is untitled).
    fn reclassify_one(&self, id: DocumentId, ws: &WorkspaceService) {
        // Snapshot the current meta, buffer, revision, and disk_version under a
        // brief lock. disk_version is preserved across reclassification (the
        // file didn't change — only its resolution scope did), so it must be
        // carried over the world rebuild (which resets it to None).
        let (meta, text, disk_version, file_identity) = {
            let tabs = self.store.tabs.read();
            let Some(tab) = tabs.get(&id).cloned() else {
                return;
            };
            let rt = tab.state.lock();
            (
                rt.meta.clone(),
                tab.world.text(),
                rt.disk_version,
                rt.file_identity,
            )
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

        // Restore the disk_version AND file_identity (the rebuild reset both to
        // None / UNKNOWN). The file is unchanged, so the pre-transition snapshot
        // is still accurate.
        if let Some(dv) = disk_version {
            if let Some(t) = self.store.tabs.read().get(&id) {
                let mut rt = t.state.lock();
                rt.disk_version = Some(dv);
                rt.file_identity = file_identity;
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
        // The legacy hard-close behavior, retained as a thin alias so existing
        // IPC callers and tests keep working. New callers that want the
        // soft-close lifecycle use [soft_close](Self::soft_close) /
        // [reactivate](Self::reactivate) / [hard_close](Self::hard_close).
        self.hard_close(id)
    }

    /// Hard-close (true destroy): tear down the compile worker, drop the
    /// `TabState` (world + cached compile result), release the canonical-path
    /// registry slot, and remove the VFS overlay entry. After this the
    /// `DocumentId` is fully gone — reopening the file mints a fresh document.
    ///
    /// This is the LRU-eviction path for the soft-close feature: when the
    /// frontend has too many hidden tabs, it upgrades the oldest to a true
    /// close via this method. It is also the old `close_tab` behavior, now
    /// named for clarity; [`close_tab`](Self::close_tab) remains as an alias.
    ///
    /// Errors with [`AppError::NotFound`] if `id` is not open.
    pub fn hard_close(&self, id: DocumentId) -> Result<()> {
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

    /// Conditionally hard-close `id`: destroy it like
    /// [`hard_close`](Self::hard_close), but ONLY if it is still clean (not
    /// dirty, no active conflict). Returns whether the doc was closed.
    ///
    /// This is the delete flow's close: the command preflights dirty docs
    /// (§5.5 block), but the trash op between preflight and close can be slow
    /// (the Windows recycle API especially), and a keystroke landing in that
    /// window marks the doc dirty AFTER the preflight blessed the delete.
    /// Destroying it then would silently discard the user's edit — so the
    /// dirty flag is re-checked here, immediately before the close, ATOMICALLY
    /// with the removal: the tabs WRITE lock is held across both the re-check
    /// and the `remove`, and `apply_text` takes the tabs READ lock before its
    /// buffer swap, so an edit either fully precedes the check (doc is dirty,
    /// close refused) or fully follows the removal (tab already gone — the
    /// edit's `NotFound` path, nothing destroyed). A raced-dirty doc is NOT
    /// closed: its buffer survives and it is marked
    /// [`ConflictState::Missing`](crate::domain::document::ConflictState::Missing)
    /// — exactly the state the watcher's `handle_external_change` would set
    /// for the now-deleted backing file — with the conflict event emitted so
    /// the frontend surfaces the recoverable "file gone" state instead of a
    /// vanishing tab.
    pub fn hard_close_if_clean(&self, id: DocumentId) -> bool {
        // Phase 1 — checked remove under the tabs write lock.
        let mut tabs = self.store.tabs.write();
        let Some(tab) = tabs.get(&id).cloned() else {
            // Already closed (raced a concurrent close / LRU eviction):
            // nothing to do, and nothing was closed by us.
            return false;
        };
        let (raced, canon) = {
            let rt = tab.state.lock();
            (
                rt.meta.dirty || rt.meta.conflict.is_active(),
                // Capture the canonical path while the tab is still reachable:
                // after the removal below, `drop_vfs_for` can no longer
                // resolve it.
                rt.meta.origin.canonical_path().map(|p| p.to_path_buf()),
            )
        };
        if raced {
            // Refused. Release the write guard before emitting (set_conflict
            // locks the tab state; the doc survives either way, so this
            // advisory marking need not be under the close's guard).
            drop(tabs);
            set_conflict(
                &tab,
                id,
                &self.store.emitter,
                ConflictState::Missing,
                None,
            );
            tracing::warn!(
                ?id,
                "delete raced a late edit; keeping the dirty doc alive as Missing"
            );
            return false;
        }
        // Still clean under the write lock → remove NOW, making the
        // check + remove one atomic step.
        tabs.remove(&id);
        drop(tabs);

        // Phase 2 — teardown tail, mirroring `hard_close`'s ordering.
        let _ = self.store.workers.write().remove(&id);
        if let Some(canon) = canon {
            self.drop_vfs_for_canon(&canon);
        }
        // Release the canonical-path slot so the file can be reopened.
        self.store.registry.write().unregister(id);
        true
    }

    /// Soft-close a tab: hide it from the tab strip but keep the worker,
    /// EditorWorld, cached compile result, registry entry, and VFS overlay
    /// alive for instant reactivation (§B1). Idempotent — soft-closing an
    /// already-hidden doc is a no-op. Errors with [`AppError::NotFound`] only
    /// if `id` is not open at all.
    ///
    /// ## Why nothing is dropped
    ///
    /// The whole point of soft-close is *zero-cost reopen*, so this method
    /// mutates ONLY the `hidden` flag:
    /// - The compile worker is kept (a reactivate must not pay thread-spawn /
    ///   world-warmup cost).
    /// - The registry entry is kept so [`find_existing`] still returns this id
    ///   — that's the reuse anchor the frontend checks on reopen.
    /// - The VFS overlay is kept. The hidden doc's unsaved buffer IS the live
    ///   content; dropping it would mean another tab that `#include`s this file
    ///   would silently see stale disk bytes while the user believes their edit
    ///   is live. [`drop_vfs_for`] is therefore NOT called here. The overlay is
    ///   cheap to keep (one String per dirty path) and is naturally released on
    ///   the eventual [`hard_close`](Self::hard_close) (LRU eviction).
    /// - The loose-file watcher is intentionally left running too, matching the
    ///   existing [`close_tab`] policy (documented there).
    pub fn soft_close(&self, id: DocumentId) -> Result<()> {
        if !self.store.tabs.read().contains_key(&id) {
            return Err(AppError::NotFound(format!("tab {id} not found")));
        }
        // Flip the flag in BOTH the registry and the runtime meta snapshot
        // (shared helper). The registry is the authority for find_existing;
        // the runtime snapshot is the authority for list_tabs / tab_meta.
        self.set_visibility(id, true);
        Ok(())
    }

    /// Flip a document's `hidden` flag in BOTH the registry and the matching
    /// [`TabRuntime`] meta snapshot under one logical operation, so
    /// `find_existing` (registry), `list_tabs` / `tab_meta` (runtime), and the
    /// frontend's `hidden` flag all agree. Shared by `soft_close` (sets true),
    /// `reactivate` (sets false), and the open-on-hit path in
    /// `open_from_disk` / `open_from_content` (sets false — reopening an
    /// open-but-hidden file makes it visible again). No-op on the runtime
    /// side if the tab is missing; the registry is the source of truth there.
    fn set_visibility(&self, id: DocumentId, hidden: bool) {
        self.store.registry.write().set_hidden(id, hidden);
        if let Some(tab) = self.store.tabs.read().get(&id).cloned() {
            tab.state.lock().meta.hidden = hidden;
        }
    }

    /// Reactivate a soft-closed document: mark it visible again (§B1). If a
    /// cached compile result (`TabRuntime::last_doc`) exists, replay it as a
    /// `compiled` event — rendered straight from the cached `PagedDocument`
    /// with NO recompilation (the `duration_ms: 0` is the signal the frontend
    /// can use to treat this as "instant"). The frontend's existing
    /// `onCompiled` listener then fills the preview uniformly.
    ///
    /// Returns the document's current [`DocumentMeta`] so the IPC layer can hand
    /// the frontend everything it needs to re-add the tab in one round-trip.
    /// If `last_doc` is `None` (never compiled successfully — e.g. the doc was
    /// soft-closed before its first compile finished), the flag is still
    /// flipped and the next natural compile event will fill the preview; no
    /// empty `compiled` event is emitted in that case.
    ///
    /// Errors with [`AppError::NotFound`] if `id` is not open.
    pub fn reactivate(&self, id: DocumentId) -> Result<DocumentMeta> {
        let tab = self.tab_cloned(id)?;
        // Flip the flag in both stores (registry + runtime meta) via the shared
        // helper, then snapshot the meta + cached last_doc for the replay.
        self.set_visibility(id, false);
        let meta = {
            let rt = tab.state.lock();
            rt.meta.clone()
        };
        self.replay_cached_compiled(id);
        Ok(meta)
    }

    /// Replay a tab's cached compile result (`TabRuntime::last_doc`) as a
    /// `compiled` event — rendered straight from the cached `PagedDocument`
    /// with NO recompilation (the `duration_ms: 0` is the signal the frontend
    /// can use to treat this as "instant"). The payload is always FULL: the
    /// receiving frontend holds no pages for the doc (a soft-closed tab
    /// reactivated, or a webview reload followed by a dedup-reopen), so an
    /// incremental compile result (`full=false`) would leave undefined holes
    /// in its page array.
    ///
    /// The replay is stamped with the revision `last_doc` actually corresponds
    /// to (`last_compiled_revision`), NOT the current `meta.revision`: if the
    /// buffer advanced past the cached compile, the honest stamp lets the
    /// frontend's stale-revision guard discard the replay. No-op when nothing
    /// is cached (`last_doc == None`, e.g. never compiled successfully) — the
    /// next natural compile event fills the preview.
    ///
    /// Shared by [`reactivate`](Self::reactivate) and the open-dedup branches
    /// of [`open_from_disk`](Self::open_from_disk) /
    /// [`open_from_content`](Self::open_from_content).
    fn replay_cached_compiled(&self, id: DocumentId) {
        let Some(tab) = self.store.tabs.read().get(&id).cloned() else {
            return;
        };
        // Stamp the replay with the revision `last_doc` actually corresponds
        // to, NOT the current `meta.revision`: if the buffer advanced past
        // the cached compile, the honest stamp lets the frontend's
        // stale-revision guard discard the replay (see `reactivate`).
        let (last_doc, revision) = {
            let rt = tab.state.lock();
            (rt.last_doc.clone(), rt.last_compiled_revision.unwrap_or(rt.meta.revision))
        };
        let Some(doc) = last_doc else { return };
        // SVG rendering is infallible; on the (impossible) error path degrade
        // to an empty page instead of panicking the replay.
        let renderer = SvgRenderer::new();
        let changed_pages: Vec<crate::ipc::events::ChangedPage> = doc
            .pages()
            .iter()
            .enumerate()
            .map(|(i, _)| crate::ipc::events::ChangedPage {
                index: i as u32,
                svg: renderer.render_single(&doc, i).unwrap_or_default(),
            })
            .collect();
        let page_count = changed_pages.len();
        let line_map = build_source_map(&doc, &tab.world);
        let outline = build_outline(&doc, &tab.world);
        self.store.emitter.emit_compiled(
            id,
            revision,
            page_count,
            /* full */ true,
            changed_pages,
            line_map,
            outline,
            /* duration_ms */ 0,
        );
    }

    /// Update text for an internal caller, allocating the next revision.
    ///
    /// The IPC path uses [`Self::update_text_at_revision`] instead because the
    /// frontend revision must survive debounce coalescing unchanged.
    pub fn update_text(&self, id: DocumentId, content: String) -> Result<()> {
        self.apply_text(id, content, None).map(|_| ())
    }

    /// Apply a frontend-versioned text snapshot.
    ///
    /// Newer revisions replace the buffer and are adopted verbatim. Older
    /// revisions are harmless no-ops, which makes concurrently completing IPC
    /// calls order-independent. An equal revision with equal content is a
    /// deliberate refresh. Equal revision with different content is the
    /// well-defined editor-wins resolution for a concurrent clean disk reload.
    pub fn update_text_at_revision(
        &self,
        id: DocumentId,
        content: String,
        revision: u64,
    ) -> Result<u64> {
        self.apply_text(id, content, Some(revision))
    }

    /// Compare-and-swap text replacement: apply `new_content` ONLY when the
    /// buffer still holds exactly `expected_text` at `observed_revision` —
    /// the state the caller observed when it computed the new content.
    ///
    /// This closes the single-intervening-write window between "read the
    /// buffer" and "write the transformed buffer" (search-replace, AI
    /// rewrite, format-on-save, …): a plain
    /// [`update_text_at_revision`](Self::update_text_at_revision) at the same
    /// revision would adopt the computed content even if an unrelated edit —
    /// or a same-revision clean disk reload — landed in between, silently
    /// destroying it.
    ///
    /// ## Semantics
    ///
    /// - **CAS hit** (text AND revision both match): identical side effects to
    ///   `update_text_at_revision`'s applied path — dirty mark, revision bump
    ///   to `observed_revision + 1`, VFS publish + dependent recompile
    ///   cascade, worker compile signal, debounced recovery snapshot.
    ///   Returns [`CasReplaceOutcome::Applied`].
    /// - **CAS miss** (text and/or revision differ): nothing is written — a
    ///   buffer whose text or revision moved is never overwritten. Returns
    ///   [`CasReplaceOutcome::Conflated`] with the FRESH current text +
    ///   revision so the caller can recompute and retry.
    ///
    /// ## Locking
    ///
    /// Same discipline as [`apply_text`](Self::apply_text): a brief tabs read
    /// lock clones the tab, then the tab's state lock covers BOTH the CAS
    /// check and the world's text replacement, so text + revision move as one
    /// atomic snapshot for compiles. An `apply_text` or `hard_close_if_clean`
    /// racing this call therefore either fully precedes the check (CAS miss /
    /// NotFound) or fully follows the swap.
    pub fn replace_text_cas(
        &self,
        id: DocumentId,
        expected_text: &str,
        new_content: String,
        observed_revision: u64,
    ) -> Result<CasReplaceOutcome> {
        let tab = self.tab_cloned(id)?;

        let meta_snapshot = {
            let mut rt = tab.state.lock();
            let current_revision = rt.meta.revision;
            let current_text = tab.world.text();
            // CAS check: only write when the buffer is exactly the state the
            // caller observed. Report the fresh state otherwise — never the
            // caller's stale copy.
            if current_revision != observed_revision || current_text != expected_text {
                return Ok(CasReplaceOutcome::Conflated {
                    text: current_text,
                    revision: current_revision,
                });
            }
            let target_revision = observed_revision.saturating_add(1);
            // Keep text + revision one atomic logical snapshot for compile —
            // the same swap `apply_text`'s applied path performs.
            tab.world.set_text(new_content.clone());
            rt.meta.revision = target_revision;
            rt.meta.dirty = true;
            rt.meta.clone()
        };

        // Side effects identical to `apply_text`'s applied path: publish the
        // live buffer into the shared VFS + cascade to dependents (§5 end),
        // signal the compile worker, schedule the debounced recovery snapshot.
        let applied_revision = meta_snapshot.revision;
        if let Some(canon) = meta_snapshot.origin.canonical_path().map(|p| p.to_path_buf()) {
            self.store
                .vfs
                .upsert(canon.clone(), new_content.clone(), applied_revision);
            self.recompile_dependents_of(&canon);
        }
        if let Some(worker) = self.store.workers.read().get(&id) {
            worker.recompile();
        }
        if let Some(recovery) = self.recovery() {
            let disk_version = meta_snapshot
                .origin
                .canonical_path()
                .and_then(|p| DiskVersion::from_path(p).ok());
            recovery.schedule_snapshot(meta_snapshot, new_content, disk_version);
        }
        Ok(CasReplaceOutcome::Applied {
            revision: applied_revision,
        })
    }

    /// Shared mutation path for internal edits and frontend-versioned edits.
    ///
    /// The state lock covers both the revision decision and the world's short
    /// text replacement. Compile snapshots take the same state→world lock
    /// order, so a compile can never observe new text stamped with an old
    /// revision (or vice versa).
    fn apply_text(
        &self,
        id: DocumentId,
        content: String,
        requested_revision: Option<u64>,
    ) -> Result<u64> {
        let tab = self.tab_cloned(id)?;

        let mut should_recompile = false;
        let mut replace_same_revision = false;
        let mut applied = None;

        let authoritative_revision = {
            let mut rt = tab.state.lock();
            let current_revision = rt.meta.revision;
            let current_text = tab.world.text();

            let target_revision = match requested_revision {
                Some(incoming) if incoming < current_revision => {
                    tracing::debug!(
                        "stale update_text ignored for {id}: incoming revision \
                         {incoming}, current revision {current_revision}"
                    );
                    return Ok(current_revision);
                }
                Some(incoming) if incoming == current_revision => {
                    if current_text == content {
                        should_recompile = true;
                    } else {
                        // A clean disk reload can win the backend revision race
                        // after Monaco has already allocated the same next
                        // revision locally. The editor buffer is authoritative
                        // for an explicit update_text, so adopt it at the same
                        // revision and mark the document dirty.
                        replace_same_revision = true;
                    }
                    current_revision
                }
                Some(incoming) => incoming,
                None if current_text == content => {
                    should_recompile = true;
                    current_revision
                }
                None => current_revision.saturating_add(1),
            };

            if target_revision > current_revision || replace_same_revision {
                // Keep text + revision one atomic logical snapshot for compile.
                tab.world.set_text(content.clone());
                rt.meta.revision = target_revision;
                rt.meta.dirty = true;
                let canon = rt.meta.origin.canonical_path().map(|p| p.to_path_buf());
                applied = Some((rt.meta.clone(), canon));
                should_recompile = true;
            }

            target_revision
        };

        // A refresh/replay may submit the exact snapshot already held by the
        // world. Recompile it, but do not manufacture an edit or recovery item.
        if applied.is_none() {
            if should_recompile {
                if let Some(worker) = self.store.workers.read().get(&id) {
                    worker.recompile();
                }
            }
            return Ok(authoritative_revision);
        }

        let (meta_snapshot, canon) = applied.expect("checked above");
        // Publish the edited buffer into the shared VFS (§5 end): another tab
        // that #includes / #reads this file must compile against the live edit,
        // not the stale disk copy. Only for documents with a canonical path.
        if let Some(canon) = canon {
            self.store.vfs.upsert(canon.clone(), content.clone(), meta_snapshot.revision);
            // Cascade a recompile to any open document that transitively
            // #includes this one (multi-file projects). The VFS upsert above
            // already published the live buffer, so dependents compile against it.
            self.recompile_dependents_of(&canon);
        }
        // Signal the worker. If it's busy compiling, the message queues; the
        // worker picks up the latest text when it finishes.
        if should_recompile {
            if let Some(worker) = self.store.workers.read().get(&id) {
                worker.recompile();
            }
        }
        // Schedule a debounced recovery snapshot (§5.1.2). Best-effort: if no
        // recovery service is wired (tests / disabled), this is a no-op. The
        // debounce coalesces bursts; the worker thread flushes after 750ms.
        if let Some(recovery) = self.recovery() {
            let disk_version = meta_snapshot
                .origin
                .canonical_path()
                .and_then(|p| DiskVersion::from_path(p).ok());
            recovery.schedule_snapshot(meta_snapshot, content, disk_version);
        }
        Ok(authoritative_revision)
    }

    /// After a change to `changed_path` (edit or external modify), recompile
    /// every open document that transitively `#include`s it. The changed
    /// document itself is already recompiled by the caller; it is never in the
    /// dependent set (a file does not include itself). Best-effort: a dependent
    /// that isn't currently open simply has no worker to signal.
    ///
    /// Lock discipline: collect dependent ids under the `tabs` read lock, drop
    /// it, then signal workers — never hold both at once.
    fn recompile_dependents_of(&self, changed_path: &Path) {
        // The dependency graph is keyed by canonical disk path (as produced by
        // the resolver). Canonicalize the change path so it matches; if that
        // fails (e.g. a just-deleted file) or yields a different form, also try
        // the raw path, so a watcher event still reaches the right dependents.
        let dependents = match canonicalize_for_identity(changed_path) {
            Ok(c) if c.as_path() == changed_path => self.store.deps.dependents_of(&c),
            Ok(c) => {
                let mut set = self.store.deps.dependents_of(&c);
                set.extend(self.store.deps.dependents_of(changed_path));
                set
            }
            Err(_) => self.store.deps.dependents_of(changed_path),
        };
        if dependents.is_empty() {
            return;
        }
        let dep_ids: Vec<DocumentId> = {
            let tabs = self.store.tabs.read();
            tabs.iter()
                .filter_map(|(id, tab)| {
                    let guard = tab.state.lock();
                    let dep_path = guard.meta.origin.canonical_path()?;
                    dependents.contains(dep_path).then_some(*id)
                })
                .collect()
        };
        let workers = self.store.workers.read();
        for id in dep_ids {
            if let Some(worker) = workers.get(&id) {
                worker.recompile();
            }
        }
    }

    /// Prepare data needed to save a tab: returns `(path, current_text)`. The
    /// command layer does the actual disk write (async). Errors if the tab is
    /// untitled (no path) or missing.
    pub fn prepare_save(&self, id: DocumentId) -> Result<(PathBuf, String)> {
        let tab = self.tab_cloned(id)?;
        let path = tab
            .state
            .lock()
            .meta
            .path
            .clone()
            .ok_or_else(|| AppError::InvalidInput("tab has no on-disk path".into()))?;
        Ok((path, tab.world.text()))
    }

    // --- conflict resolution (§5.4) ------------------------------------------

    /// Resolve a conflict by adopting the DISK version: replace the buffer with
    /// the current on-disk content, bump the revision, clear `dirty`, clear the
    /// conflict, and re-baseline the stored [`DiskVersion`] + [`FileIdentity`].
    /// (§5.4 使用磁盘版本). Available only when the backing file is readable
    /// (the `Modified` case) — returns a `NotFound` error for `Missing` and an
    /// `InvalidInput` for untitled / `PermissionChanged`.
    ///
    /// Returns the disk content that was loaded into the buffer (so the IPC
    /// layer can hydrate the frontend's copy without a second read).
    pub fn resolve_conflict_use_disk(
        &self,
        id: DocumentId,
        frontend_revision: Option<u64>,
    ) -> Result<(String, u64)> {
        let tab = self.tab_cloned(id)?;
        let path = tab
            .state
            .lock()
            .meta
            .path
            .clone()
            .ok_or_else(|| AppError::InvalidInput("tab has no on-disk path".into()))?;
        // Read the current disk content. A `Missing` conflict's file may be
        // gone — surface that as NotFound so the caller can tell the user to
        // recreate / Save As instead.
        let content = std::fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(format!("file gone: {path:?}"))
            } else {
                AppError::Io(e)
            }
        })?;
        // Re-baseline the disk version + identity from the bytes we just read.
        let new_version = DiskVersion::from_bytes(content.as_bytes());
        let new_identity = crate::domain::disk_version::FileIdentity::from_path(&path);
        tab.world.set_text(content.clone());
        let (revision, canon) = {
            let mut rt = tab.state.lock();
            let backend_next = rt.meta.revision.saturating_add(1);
            let frontend_next = frontend_revision
                .map(|revision| revision.saturating_add(1))
                .unwrap_or(backend_next);
            rt.meta.revision = backend_next.max(frontend_next);
            rt.meta.dirty = false;
            rt.meta.conflict = ConflictState::None;
            rt.disk_version = Some(new_version);
            rt.file_identity = new_identity;
            (
                rt.meta.revision,
                rt.meta.origin.canonical_path().map(|p| p.to_path_buf()),
            )
        };
        // Keep the shared VFS in step with the adopted buffer (§5 end).
        if let Some(canon) = canon {
            self.store.vfs.upsert(canon.clone(), content.clone(), revision);
            // Cascade to documents that #include this one: the buffer just
            // changed from the user's dirty edit to the disk version.
            self.recompile_dependents_of(&canon);
        }
        // Recompile against the new buffer.
        if let Some(worker) = self.store.workers.read().get(&id) {
            worker.recompile();
        }
        // The doc is now clean on disk → discard its recovery snapshot (§5.1.2).
        if let Some(recovery) = self.recovery() {
            recovery.discard_snapshot(id);
        }
        Ok((content, revision))
    }

    /// Clear the conflict flag WITHOUT touching the buffer or dirty state
    /// (§5.4). Used by the "Later" / discard resolution paths and by the
    /// `clear_conflict` IPC command. No-op (returns Ok) for an unknown id.
    pub fn clear_conflict(&self, id: DocumentId) -> Result<()> {
        if let Some(t) = self.store.tabs.read().get(&id) {
            t.state.lock().meta.conflict = ConflictState::None;
        }
        Ok(())
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

    /// Flush all dirty buffers to recovery snapshots immediately, bypassing the
    /// debounce (§5.1.2 blur / sleep / close paths). No-op when recovery is not
    /// wired. The flush runs on the caller's thread via the recovery worker's
    /// `flush_now` channel.
    pub fn flush_recovery(&self) {
        let Some(recovery) = self.recovery() else { return };
        // Snapshot the dirty docs + their text under brief locks, then hand the
        // whole batch to the synchronous snapshot API so the close/blur path
        // sees durable snapshots on return (the debounced worker is not waited
        // on here — flush_now coalesces with it).
        let docs = self.list_tabs();
        let store = self.store.clone();
        recovery.snapshot_dirty_documents(&docs, move |id| {
            store.tabs.read().get(&id).map(|t| t.world.text())
        });
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
    use crate::domain::document::DocumentOrigin;
    use crate::service::compile_service::CompileService;
    use crate::service::editor_service::Emitter;
    use crate::service::tab_store::TabStore;
    use crate::service::test_support::{wait_until, CapturingEmitter};

    /// Build a wired pair of (DocumentService, CompileService) sharing one store,
    /// exactly as `EditorService::new` does — but exercising the services
    /// directly, not through the facade. This proves they are real, working
    /// services rather than dead shells.
    fn make_services() -> (Arc<DocumentService>, Arc<CompileService>) {
        let emitter: Arc<dyn Emitter> = Arc::new(CapturingEmitter::new());
        let store = TabStore::new(emitter);
        let document = Arc::new(DocumentService::new(store.clone()));
        let compile = Arc::new(CompileService::new(store));
        document.with_compile(compile.clone());
        (document, compile)
    }

    /// Like [`make_services`] but also hands back the concrete emitter so
    /// a test can inspect which `compiled` events were emitted (e.g. the
    /// reactivate-replay assertion). The emitter is the same `Arc` shared with
    /// the services, so its captured events reflect everything they emit.
    fn make_services_with_spy()
    -> (Arc<DocumentService>, Arc<CompileService>, Arc<CapturingEmitter>) {
        let emitter = Arc::new(CapturingEmitter::new());
        let store = TabStore::new(emitter.clone());
        let document = Arc::new(DocumentService::new(store.clone()));
        let compile = Arc::new(CompileService::new(store));
        document.with_compile(compile.clone());
        (document, compile, emitter)
    }

    fn wait_for_compiled(compile: &CompileService, id: DocumentId) {
        // last_doc is Some only after a compile completes and stored its result,
        // so polling it is a reliable "compile finished" signal.
        if !wait_until(60, || compile.last_doc(id).is_some()) {
            panic!("no compiled document for {id} within timeout");
        }
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
    fn versioned_update_adopts_debounced_frontend_revision_exactly() {
        let (document, compile) = make_services();
        let meta = document.new_tab(Some("".into()));

        // Three Monaco edits may be coalesced into one IPC. The surviving
        // snapshot is revision 3, not "one backend call" revision 1.
        let acknowledged = document
            .update_text_at_revision(meta.id, "abc".into(), 3)
            .unwrap();

        assert_eq!(acknowledged, 3);
        assert_eq!(document.tab_revision(meta.id), Some(3));
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("abc"));

        // The compiler must stamp the same end-to-end version on its result.
        compile.compile_now(meta.id);
        assert_eq!(
            compile
                .last_compile_state(meta.id)
                .and_then(|state| state.last_compiled_revision),
            Some(3)
        );
    }

    #[test]
    fn versioned_update_ignores_late_older_snapshot() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(Some("initial".into()));

        document
            .update_text_at_revision(meta.id, "newest".into(), 5)
            .unwrap();
        let acknowledged = document
            .update_text_at_revision(meta.id, "late stale value".into(), 4)
            .unwrap();

        assert_eq!(acknowledged, 5);
        assert_eq!(document.tab_revision(meta.id), Some(5));
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("newest"));
    }

    #[test]
    fn equal_revision_refresh_and_disk_reload_collision_are_safe() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(Some("initial".into()));
        document
            .update_text_at_revision(meta.id, "current".into(), 7)
            .unwrap();

        // Manual refresh: same version + same content is a recompile request,
        // not a new edit.
        assert_eq!(
            document
                .update_text_at_revision(meta.id, "current".into(), 7)
                .unwrap(),
            7
        );

        // A backend disk reload may have independently allocated the same
        // revision after Monaco's edit. The explicit editor snapshot wins and
        // becomes dirty without creating yet another revision.
        assert_eq!(
            document
                .update_text_at_revision(meta.id, "conflict".into(), 7)
                .unwrap(),
            7
        );
        assert_eq!(document.tab_revision(meta.id), Some(7));
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("conflict"));
        assert!(document.tab_meta(meta.id).unwrap().dirty);
    }

    // --- replace_text_cas -----------------------------------------------------

    #[test]
    fn replace_text_cas_applies_cleanly_and_bumps_revision() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(Some("v0".into()));
        assert_eq!(document.tab_revision(meta.id), Some(0));

        let outcome = document
            .replace_text_cas(meta.id, "v0", "computed v1".into(), 0)
            .unwrap();
        match outcome {
            CasReplaceOutcome::Applied { revision } => assert_eq!(revision, 1),
            other => panic!("expected Applied, got {other:?}"),
        }
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("computed v1"));
        assert_eq!(document.tab_revision(meta.id), Some(1));
        assert!(document.tab_meta(meta.id).unwrap().dirty, "CAS apply marks dirty");
    }

    #[test]
    fn replace_text_cas_rejects_on_text_drift() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(Some("v0".into()));
        // A same-revision replacement (apply_text's disk-reload-collision
        // path) moved the TEXT without moving the revision.
        document
            .update_text_at_revision(meta.id, "drifted".into(), 0)
            .unwrap();

        // The caller still believes "v0" @ 0 — text drift alone must reject.
        let outcome = document
            .replace_text_cas(meta.id, "v0", "computed".into(), 0)
            .unwrap();
        match outcome {
            CasReplaceOutcome::Conflated { text, revision } => {
                assert_eq!(text, "drifted", "Conflated carries the FRESH text");
                assert_eq!(revision, 0);
            }
            other => panic!("expected Conflated, got {other:?}"),
        }
        assert_eq!(
            document.tab_text(meta.id).as_deref(),
            Some("drifted"),
            "a CAS miss must never overwrite the buffer"
        );
    }

    #[test]
    fn replace_text_cas_rejects_on_revision_drift() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(Some("v0".into()));
        // An edit advances revision 0 → 1.
        document
            .update_text_at_revision(meta.id, "v0-edited".into(), 1)
            .unwrap();

        // Stale observation on BOTH axes → reject…
        let outcome = document
            .replace_text_cas(meta.id, "v0", "computed".into(), 0)
            .unwrap();
        assert!(
            matches!(&outcome, CasReplaceOutcome::Conflated { text, revision }
                if text == "v0-edited" && *revision == 1),
            "expected Conflated with fresh state, got {outcome:?}"
        );

        // …and revision drift ALONE (text matches) must reject too — writing
        // at a stale revision would clobber whatever moved it.
        let outcome = document
            .replace_text_cas(meta.id, "v0-edited", "computed".into(), 0)
            .unwrap();
        assert!(
            matches!(&outcome, CasReplaceOutcome::Conflated { revision: 1, .. }),
            "revision drift alone must reject, got {outcome:?}"
        );
        assert_eq!(
            document.tab_text(meta.id).as_deref(),
            Some("v0-edited"),
            "buffer must be untouched on revision drift"
        );
    }

    /// The applied path must be side-effect-equivalent to
    /// `update_text_at_revision`: same revision bump, same dirty mark, same
    /// VFS publish (text + revision under the canonical path).
    #[test]
    fn replace_text_cas_side_effects_match_update_text_at_revision() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir()
            .join(format!("ts-cas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path_a = dir.join("a.typ");
        let path_b = dir.join("b.typ");
        std::fs::write(&path_a, "v0").unwrap();
        std::fs::write(&path_b, "v0").unwrap();

        let a = document.open_from_content(path_a.clone(), "v0".into(), None).unwrap();
        let b = document.open_from_content(path_b.clone(), "v0".into(), None).unwrap();

        // Identical edit through the two paths: an explicit next-revision
        // update vs a CAS on the observed (text, revision).
        document.update_text_at_revision(a.id, "v1".into(), 1).unwrap();
        match document.replace_text_cas(b.id, "v0", "v1".into(), 0).unwrap() {
            CasReplaceOutcome::Applied { revision } => assert_eq!(revision, 1),
            other => panic!("expected Applied, got {other:?}"),
        }

        for (id, path) in [(a.id, &path_a), (b.id, &path_b)] {
            assert_eq!(document.tab_revision(id), Some(1), "same revision bump");
            assert!(document.tab_meta(id).unwrap().dirty, "same dirty mark");
            assert_eq!(document.tab_text(id).as_deref(), Some("v1"));
            let entry = document.store.vfs.get(path).expect("VFS entry published");
            assert_eq!(entry.text, "v1", "same VFS text for {path:?}");
            assert_eq!(entry.revision, 1, "same VFS revision for {path:?}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn document_service_same_text_recompile_does_not_create_an_edit() {
        let (document, _compile) = make_services();
        let content = "#set page(width: 10cm)\n\nHello";
        let meta = document.new_tab(Some(content.into()));

        document.update_text(meta.id, content.into()).unwrap();

        let after = document.tab_meta(meta.id).unwrap();
        assert_eq!(after.revision, meta.revision);
        assert!(!after.dirty);
        assert_eq!(document.tab_text(meta.id).as_deref(), Some(content));
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
        wait_until(40, || !compile.get_diagnostics(meta.id).is_empty());
        let diags = compile.get_diagnostics(meta.id);
        assert!(!diags.is_empty(), "failing source must surface diagnostics via CompileService");
        let state = compile.last_compile_state(meta.id).expect("state present");
        assert!(!state.success, "compile state must report failure");
    }

    /// Test helper: set the conflict state on a tab (mirrors what the watcher's
    /// `set_conflict` does) by reaching through the cfg(test) store accessor.
    fn force_conflict(document: &DocumentService, id: DocumentId, conflict: ConflictState) {
        let tab = document
            .store()
            .tabs
            .read()
            .get(&id)
            .cloned()
            .expect("tab exists");
        tab.state.lock().meta.conflict = conflict;
    }

    /// §11.3 / §5.4 acceptance: `resolve_conflict_use_disk` replaces the buffer
    /// with the current disk content, bumps the revision, and clears BOTH dirty
    /// and the conflict flag. The disk version is re-baselined so the imminent
    /// self-save watcher event compares equal.
    #[test]
    fn resolve_conflict_use_disk_clears_conflict_and_dirty() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-docsvc-ud-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "#set page(width: 10cm)\n\nDisk wins").unwrap();

        let meta = document
            .open_from_content(path.clone(), "#set page(width: 10cm)\n\nDisk wins".into(), None)
            .unwrap();
        // Dirty the buffer (unsaved local edits) and mark it conflicted.
        document.update_text(meta.id, "#set page(width: 10cm)\n\nMy local edit".into()).unwrap();
        force_conflict(&document, meta.id, ConflictState::Modified { disk_version: None });
        let rev_before = document.tab_revision(meta.id).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty);

        // Externally change the disk to a third version — use_disk should adopt
        // whatever is on disk NOW, not the version at detection time.
        std::fs::write(&path, "#set page(width: 10cm)\n\nFresh disk version").unwrap();

        let (adopted, adopted_revision) = document
            .resolve_conflict_use_disk(meta.id, None)
            .expect("use_disk succeeds");
        assert_eq!(adopted, "#set page(width: 10cm)\n\nFresh disk version");

        // Buffer now matches disk; revision bumped; dirty + conflict cleared.
        assert_eq!(
            document.tab_text(meta.id).as_deref(),
            Some("#set page(width: 10cm)\n\nFresh disk version")
        );
        let after = document.tab_meta(meta.id).unwrap();
        assert!(!after.dirty, "dirty must clear on use_disk");
        assert!(!after.conflict.is_active(), "conflict must clear on use_disk");
        assert!(
            adopted_revision > rev_before,
            "revision must bump on use_disk"
        );
        assert_eq!(document.tab_revision(meta.id).unwrap(), adopted_revision);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_conflict_use_disk_rejects_late_debounced_frontend_edit() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-docsvc-bounce-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "disk v1").unwrap();

        let meta = document.open_from_content(path.clone(), "disk v1".into(), None).unwrap();
        document
            .update_text_at_revision(meta.id, "local pending edit".into(), 10)
            .unwrap();
        force_conflict(&document, meta.id, ConflictState::Modified { disk_version: None });
        std::fs::write(&path, "disk v2").unwrap();

        let (adopted, adopted_revision) = document
            .resolve_conflict_use_disk(meta.id, Some(10))
            .expect("use_disk succeeds");

        assert_eq!(adopted, "disk v2");
        assert_eq!(adopted_revision, 11);

        let returned_revision = document
            .update_text_at_revision(meta.id, "local pending edit".into(), 10)
            .expect("late edit is accepted as stale no-op");

        assert_eq!(returned_revision, adopted_revision);
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("disk v2"));
        assert!(!document.tab_meta(meta.id).unwrap().dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.4: `resolve_conflict_use_disk` on a Missing conflict (file gone)
    /// surfaces NotFound so the dialog can offer recreate / Save As instead of
    /// silently failing.
    #[test]
    fn resolve_conflict_use_disk_missing_file_errors() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-docsvc-miss-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gone.typ");
        std::fs::write(&path, "x").unwrap();

        let meta = document.open_from_content(path.clone(), "x".into(), None).unwrap();
        force_conflict(&document, meta.id, ConflictState::Missing);
        std::fs::remove_file(&path).unwrap();

        let err = document.resolve_conflict_use_disk(meta.id, None).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::NotFound(_)),
            "missing file must surface NotFound, got {err:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.4: `clear_conflict` drops the flag without touching the buffer or
    /// dirty state (the "Later" / discard path). Idempotent for an unknown id.
    #[test]
    fn clear_conflict_drops_flag_without_touching_buffer() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(Some("hello".into()));
        document.update_text(meta.id, "hello edited".into()).unwrap();
        force_conflict(&document, meta.id, ConflictState::Missing);
        assert!(document.tab_meta(meta.id).unwrap().dirty);
        assert!(document.tab_meta(meta.id).unwrap().conflict.is_active());

        document.clear_conflict(meta.id).unwrap();
        let after = document.tab_meta(meta.id).unwrap();
        // Conflict cleared, but dirty + buffer preserved.
        assert!(!after.conflict.is_active());
        assert!(after.dirty, "dirty must be preserved by clear_conflict");
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("hello edited"));

        // Idempotent for an unknown id (no error).
        document.clear_conflict(DocumentId::new()).unwrap();
    }

    // --- §5.5 / §6.4: dirty-delete detection + rename 联动 -------------------

    /// `docs_under_path` (§5.5) finds open docs AT or UNDER the prefix and
    /// reports each one's dirty flag, so the IPC delete command can block when
    /// any is dirty. Untitled docs (no canonical path) are never affected.
    #[test]
    fn docs_under_path_reports_dirty_for_docs_at_and_under_prefix() {
        let (document, _compile) = make_services();
        // Canonicalize the temp dir so the prefix matches the docs' canonical
        // paths (`temp_dir()` may live under a symlink, e.g. /var → /private/var
        // on macOS). The production IPC layer gets this for free because the
        // workspace root is canonicalized at open.
        let dir = std::env::temp_dir().join(format!("ts-ren-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let a = dir.join("a.typ"); // at the dir root
        let b = dir.join("sub/b.typ"); // under a subdir
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "y").unwrap();

        let meta_a = document.open_from_content(a.clone(), "x".into(), None).unwrap();
        let meta_b = document.open_from_content(b.clone(), "y".into(), None).unwrap();
        // Dirty a; leave b clean.
        document.update_text(meta_a.id, "edited".into()).unwrap();

        // Deleting the whole dir → both docs affected, one dirty.
        let affected = document.docs_under_path(&dir);
        assert_eq!(affected.len(), 2, "both open docs are under the dir");
        let dirty_count = affected.iter().filter(|d| d.dirty).count();
        assert_eq!(dirty_count, 1, "exactly one doc (a) is dirty");

        // Deleting just the subdir → only b.
        let under_sub = document.docs_under_path(&dir.join("sub"));
        assert_eq!(under_sub.len(), 1);
        assert_eq!(under_sub[0].id, meta_b.id);
        assert!(!under_sub[0].dirty, "b is clean");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Soft-closed (hidden) docs are excluded from `docs_under_path` and
    /// `docs_at_paths`: the user dismissed them, so they must not block a
    /// delete or template-overwrite of their backing file. A stale hidden doc
    /// carrying an unresolved conflict would otherwise block the op forever.
    #[test]
    fn hidden_docs_are_excluded_from_delete_and_template_preflight() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-hidden-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "x").unwrap();

        let meta = document.open_from_content(path.clone(), "x".into(), None).unwrap();
        // Even a dirty + conflicted hidden doc is ignored once soft-closed.
        document.update_text(meta.id, "unsaved".into()).unwrap();
        force_conflict(&document, meta.id, ConflictState::Modified { disk_version: None });
        document.soft_close(meta.id).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().hidden);

        // docs_under_path no longer reports the hidden doc.
        let under = document.docs_under_path(&dir);
        assert!(under.is_empty(), "hidden doc must not block delete; got {under:?}");

        // docs_at_paths (template preflight) likewise ignores it.
        let at = document.docs_at_paths(std::slice::from_ref(&path));
        assert!(at.is_empty(), "hidden doc must not block template; got {at:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `docs_under_path_with_hidden` is the DELETE-flow query: unlike
    /// [`docs_under_path`](Self::docs_under_path) (visible-only), it MUST
    /// include soft-closed docs. Once the backing file is trashed, a clean
    /// hidden tab is a zombie (reactivate can never work) and must be
    /// hard-closed like a visible one; a DIRTY hidden tab still holds unsaved
    /// edits, so it must surface here (with `dirty == true`) to BLOCK the
    /// delete — silently trashing its buffer would lose those edits.
    #[test]
    fn docs_under_path_with_hidden_includes_soft_closed_tabs() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-hidden-del-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let dirty_path = dir.join("dirty.typ");
        let clean_path = dir.join("clean.typ");
        std::fs::write(&dirty_path, "x").unwrap();
        std::fs::write(&clean_path, "y").unwrap();

        // A dirty hidden doc + a clean hidden doc, both soft-closed.
        let dirty = document.open_from_content(dirty_path.clone(), "x".into(), None).unwrap();
        document.update_text(dirty.id, "unsaved".into()).unwrap();
        let clean = document.open_from_content(clean_path.clone(), "y".into(), None).unwrap();
        document.soft_close(dirty.id).unwrap();
        document.soft_close(clean.id).unwrap();

        // Visible-only query stays empty (existing contract)…
        assert!(document.docs_under_path(&dir).is_empty());
        // …but the delete preflight sees BOTH hidden docs — the dirty one to
        // block on, the clean one to hard-close afterwards.
        let with_hidden = document.docs_under_path_with_hidden(&dir);
        assert_eq!(with_hidden.len(), 2, "both hidden docs must be reported");
        assert!(with_hidden.iter().any(|d| d.id == dirty.id && d.dirty));
        assert!(with_hidden.iter().any(|d| d.id == clean.id && !d.dirty));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.5 dirty-race regression (delete preflight vs. hard close): the trash
    /// op between the preflight and the close can be slow, and a keystroke
    /// landing in that window turns a preflight-clean doc dirty. Closing it
    /// anyway would silently destroy the edit — `hard_close_if_clean` must
    /// keep the doc alive and mark it `Missing` (the watcher-equivalent
    /// recoverable state for a deleted backing file) instead.
    #[test]
    fn hard_close_if_clean_keeps_raced_dirty_doc_as_missing() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-racedel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "x").unwrap();

        let meta = document.open_from_content(path.clone(), "x".into(), None).unwrap();
        // Simulate the race: preflight saw a clean doc, an edit lands AFTER it
        // (the delete command's trash op is still running) and BEFORE the close.
        document.update_text(meta.id, "late keystroke".into()).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty);

        assert!(
            !document.hard_close_if_clean(meta.id),
            "a raced-dirty doc must NOT be hard-closed"
        );
        // The doc survives with its buffer intact and is now Missing — the
        // recoverable state, so the user can still save the edit elsewhere.
        let after = document.tab_meta(meta.id).expect("raced-dirty doc must survive");
        assert!(after.dirty, "the late edit must remain unsaved-dirty");
        assert!(
            matches!(after.conflict, ConflictState::Missing),
            "conflict must be Missing, got {:?}",
            after.conflict
        );
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("late keystroke"));

        // A clean doc IS closed (the normal delete-flow outcome).
        let clean_path = dir.join("clean.typ");
        std::fs::write(&clean_path, "y").unwrap();
        let clean = document.open_from_content(clean_path, "y".into(), None).unwrap();
        assert!(document.hard_close_if_clean(clean.id));
        assert!(document.tab_meta(clean.id).is_none(), "clean doc must be closed");

        // An already-closed id reports not-closed without erroring.
        assert!(!document.hard_close_if_clean(clean.id));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `docs_at_paths_with_hidden` is the search-replace routing query: unlike
    /// [`docs_at_paths`](Self::docs_at_paths) (which skips hidden tabs for the
    /// delete/template preflights), it MUST include soft-closed docs. A hidden
    /// tab still owns a live (possibly dirty) buffer in memory, so replace has
    /// to splice that buffer in-memory via `update_text` — NOT write disk based
    /// on the (stale) disk content, which would silently discard the unsaved
    /// edits the user parked in the background tab.
    #[test]
    fn docs_at_paths_with_hidden_includes_soft_closed_tabs() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-hidden-replace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "x").unwrap();

        // A second, visible doc at a sibling path — to confirm the visible path
        // is still reported (the new helper is a superset of docs_at_paths).
        let path2 = dir.join("other.typ");
        std::fs::write(&path2, "y").unwrap();
        let visible = document.open_from_content(path2.clone(), "y".into(), None).unwrap();

        let hidden = document.open_from_content(path.clone(), "x".into(), None).unwrap();
        document.update_text(hidden.id, "unsaved".into()).unwrap(); // dirty buffer
        document.soft_close(hidden.id).unwrap();
        assert!(document.tab_meta(hidden.id).unwrap().hidden);

        // docs_at_paths excludes the hidden doc (the existing contract).
        let at = document.docs_at_paths(&[path.clone(), path2.clone()]);
        assert_eq!(at.len(), 1);
        assert_eq!(at[0].id, visible.id);

        // docs_at_paths_with_hidden reports BOTH — including the dirty hidden
        // one, so replace routes it through the buffer (not the disk).
        let with_hidden = document.docs_at_paths_with_hidden(&[path.clone(), path2.clone()]);
        assert_eq!(with_hidden.len(), 2, "expected both visible + hidden; got {with_hidden:?}");
        assert!(with_hidden.iter().any(|d| d.id == hidden.id && d.dirty));
        assert!(with_hidden.iter().any(|d| d.id == visible.id));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §11.4 "重命名目录后所有打开子文档路径同步更新": renaming a directory
    /// rebinds EVERY open doc under it to the matching path under the new dir.
    /// The doc's canonical path, registry key, and origin all move; the buffer +
    /// id + revision are preserved; the rebuilt world still compiles.
    #[test]
    // On Windows, `open_from_content` registers a loose-file `notify` watcher
    // on `src/`, which holds a directory handle. Renaming a directory that has
    // an open handle fails with `ERROR_ACCESS_DENIED` (os error 5) — a
    // filesystem-locking constraint unrelated to the rebind logic under test
    // (which is covered by the single-file rename siblings on Windows).
    #[cfg_attr(windows, ignore = "Windows forbids renaming a watched directory (open handle)")]
    fn rebind_for_rename_moves_all_open_docs_under_a_directory() {
        let (document, compile) = make_services();
        // Canonicalize so the prefix matches the docs' canonical paths (macOS
        // /var → /private/var symlink; the workspace IPC gets canonicalization
        // for free via the canonicalized workspace root). Use the same helper
        // production uses so the Windows `\\?\` prefix is stripped to match the
        // simplified form stored in `DocumentOrigin`.
        let dir = std::env::temp_dir().join(format!("ts-rename-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = canonicalize_for_identity(&dir).unwrap();
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let a = src.join("a.typ");
        let nested = src.join("nested/b.typ");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(&a, "#set page(width: 10cm)\n\nA").unwrap();
        std::fs::write(&nested, "#set page(width: 10cm)\n\nB").unwrap();

        let meta_a = document.open_from_content(a.clone(), "#set page(width: 10cm)\n\nA".into(), None).unwrap();
        let meta_b = document
            .open_from_content(nested.clone(), "#set page(width: 10cm)\n\nB".into(), None)
            .unwrap();

        // Simulate the disk rename: src → src2 (the IPC command does this first).
        std::fs::rename(&src, dir.join("src2")).unwrap();

        // Rebind every open doc under the old src/ prefix to src2/.
        let rebound = document.rebind_for_rename(&src, &dir.join("src2"));
        assert_eq!(rebound.len(), 2, "both docs under src/ must rebind");

        // Each doc's canonical path + origin moved to src2/.
        let after_a = document.tab_meta(meta_a.id).unwrap();
        let after_b = document.tab_meta(meta_b.id).unwrap();
        assert_eq!(
            after_a.origin.canonical_path(),
            Some(dir.join("src2/a.typ").as_path()),
            "a.typ must be rebound under src2/"
        );
        assert_eq!(
            after_b.origin.canonical_path(),
            Some(dir.join("src2/nested/b.typ").as_path()),
            "nested/b.typ must be rebound under src2/nested/"
        );

        // The registry keys the docs at their NEW canonical paths.
        let reg = document.registry();
        let reg = reg.read();
        assert_eq!(
            reg.find_by_canonical(&dir.join("src2/a.typ")),
            Some(meta_a.id),
            "registry must key a.typ at src2/"
        );
        assert_eq!(
            reg.find_by_canonical(&dir.join("src2/nested/b.typ")),
            Some(meta_b.id),
            "registry must key b.typ at src2/nested/"
        );
        // The old paths are free.
        assert!(reg.find_by_canonical(&a).is_none());
        assert!(reg.find_by_canonical(&nested).is_none());

        // The id + buffer + revision are preserved across the rename.
        assert_eq!(after_a.id, meta_a.id, "id is stable across rename");
        assert_eq!(
            document.tab_text(meta_a.id).as_deref(),
            Some("#set page(width: 10cm)\n\nA"),
            "buffer preserved"
        );

        // The rebuilt world still compiles (worker rotated → recompile).
        wait_for_compiled(&compile, meta_a.id);
        assert!(
            compile.last_doc(meta_a.id).is_some(),
            "rebound doc must still compile after the rename"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `rebind_for_rename` for a single FILE rename (not a dir) rebinds just
    /// that file's open doc, preserving the buffer + id.
    #[test]
    fn rebind_for_rename_for_a_single_file_rebinds_its_doc() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-rename-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Canonicalize via the same helper production uses, so on Windows the
        // `\\?\` verbatim prefix is stripped — matching the simplified form
        // stored in `DocumentOrigin` (a raw `canonicalize()` would leave it).
        let dir = canonicalize_for_identity(&dir).unwrap();
        let from = dir.join("old.typ");
        let to = dir.join("new.typ");
        std::fs::write(&from, "content").unwrap();

        let meta = document.open_from_content(from.clone(), "content".into(), None).unwrap();
        std::fs::rename(&from, &to).unwrap();

        let rebound = document.rebind_for_rename(&from, &to);
        assert_eq!(rebound.len(), 1);
        assert_eq!(rebound[0].id, meta.id);

        let after = document.tab_meta(meta.id).unwrap();
        assert_eq!(after.origin.canonical_path(), Some(to.as_path()));
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("content"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression: renaming a file/dir with a DIRTY open doc must preserve the
    /// dirty flag across the rebind. The rebuilt meta used to recompute
    /// `dirty = false` for generic rebinds (`saved_revision == None`), so
    /// delete protection (`docs_under_path_with_hidden` → DeleteBlocked) and
    /// recovery snapshotting (`snapshot_dirty_documents` filters on
    /// `meta.dirty`) would both silently stop seeing the unsaved buffer.
    #[test]
    fn rebind_for_rename_preserves_dirty_buffer() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-rename-dirty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = canonicalize_for_identity(&dir).unwrap();
        let from = dir.join("old.typ");
        let to = dir.join("new.typ");
        std::fs::write(&from, "content").unwrap();

        let meta = document.open_from_content(from.clone(), "content".into(), None).unwrap();
        // Unsaved edit → dirty.
        document.update_text(meta.id, "unsaved edit".into()).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().dirty);

        std::fs::rename(&from, &to).unwrap();
        let rebound = document.rebind_for_rename(&from, &to);
        assert_eq!(rebound.len(), 1);

        // The dirty flag AND the unsaved buffer survive the rebind.
        let after = document.tab_meta(meta.id).unwrap();
        assert!(after.dirty, "a rename must not clear the dirty flag");
        assert_eq!(document.tab_text(meta.id).as_deref(), Some("unsaved edit"));
        // Consequently delete protection under the NEW path still sees it.
        let affected = document.docs_under_path_with_hidden(&dir);
        assert!(
            affected.iter().any(|d| d.id == meta.id && d.dirty),
            "the renamed dirty doc must still block deletes at its new path, got {affected:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §6.4 / §11.4 "文件操作失败时 registry、UI 和磁盘保持一致": a rename whose
    /// target is ALREADY an open doc leaves everything unchanged. `rebind_path`
    /// rejects the conflicting target (AlreadyOpen); the offending doc is left
    /// at its old path (NOT half-rebound), and other docs in the same batch are
    /// still rebound.
    #[test]
    fn rebind_for_rename_to_already_open_target_leaves_doc_unchanged() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-rename-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = canonicalize_for_identity(&dir).unwrap();
        let from = dir.join("from.typ");
        let target = dir.join("target.typ");
        std::fs::write(&from, "src").unwrap();
        std::fs::write(&target, "dst").unwrap();

        let meta_from = document.open_from_content(from.clone(), "src".into(), None).unwrap();
        let _meta_target = document.open_from_content(target.clone(), "dst".into(), None).unwrap();

        std::fs::rename(&from, &target).unwrap();
        // Rebind `from`'s doc onto `target` — but target is already open → the
        // rebind is rejected, and `from`'s doc is left at its old path.
        let rebound = document.rebind_for_rename(&from, &target);
        assert!(
            rebound.is_empty(),
            "the conflicting rebind must not be reported as rebound, got {rebound:?}"
        );
        // The from doc is unchanged (its canonical path is still `from`, buffer
        // intact). The disk moved (simulating the recoverable state), but the
        // doc identity is preserved — the watcher would mark it Missing next.
        let after = document.tab_meta(meta_from.id).unwrap();
        assert_eq!(
            after.origin.canonical_path(),
            Some(from.as_path()),
            "from doc must stay at its old path on a conflicting rebind"
        );
        assert_eq!(document.tab_text(meta_from.id).as_deref(), Some("src"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §6.4 "include 依赖的重新编译": after a rename, a doc that #includes the
    /// renamed file must resolve against its NEW path. The mechanism is the
    /// shared VFS re-key (`rebind_path` drops the old canonical entry and
    /// publishes the buffer under the new one). This test verifies the re-key:
    /// the renamed doc's buffer is served under the NEW canonical path (and no
    /// longer under the OLD one) after `rebind_for_rename`, so an includer's
    /// next compile picks up the renamed location.
    #[test]
    fn rebind_for_rename_rekeys_shared_vfs_to_new_path() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-rename-vfs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = canonicalize_for_identity(&dir).unwrap();
        let from = dir.join("old.typ");
        let to = dir.join("new.typ");
        std::fs::write(&from, "content").unwrap();

        let meta = document.open_from_content(from.clone(), "content".into(), None).unwrap();
        // Before the rename, the VFS serves the buffer under the OLD path.
        assert!(
            document.store.vfs.get(&from).is_some(),
            "VFS must serve the buffer under the old canonical path before rename"
        );

        std::fs::rename(&from, &to).unwrap();
        document.rebind_for_rename(&from, &to);

        // After the rename, the VFS serves the buffer under the NEW path, and
        // the OLD path entry is gone — so an includer's next compile resolves
        // the renamed file at its new location.
        assert!(
            document.store.vfs.get(&to).is_some(),
            "VFS must serve the buffer under the new canonical path after rename"
        );
        assert!(
            document.store.vfs.get(&from).is_none(),
            "VFS must drop the old canonical path entry after rename"
        );
        let _ = meta; // keep the doc alive
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory rename rebinds every open doc under the prefix — including
    /// NON-Typst tabs (image / pdf / markdown, opened via
    /// `open_non_typst_from_disk` without a compile worker) and soft-closed
    /// (hidden) / conflicted ones. The rebind must preserve `kind`,
    /// `conflict`, and `hidden` from the CURRENT meta, and must NOT spawn a
    /// compile worker for a non-Typst buffer.
    #[test]
    fn rebind_for_rename_preserves_non_typst_kind_conflict_and_hidden() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir().join(format!("ts-rename-img-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = canonicalize_for_identity(&dir).unwrap();
        let src = dir.join("assets");
        let dst = dir.join("assets2");
        std::fs::create_dir_all(&src).unwrap();
        let img = src.join("pic.png");
        std::fs::write(&img, b"\x89PNG not really").unwrap();

        let meta = document
            .open_non_typst_from_disk(
                img.clone(),
                crate::domain::document::DocumentKind::Image,
                String::new(),
                None,
            )
            .unwrap();
        assert!(
            !document.store().workers.read().contains_key(&meta.id),
            "non-Typst open never spawns a compile worker"
        );
        // Soft-close (hidden) + an active conflict — both must survive the
        // rebind instead of being reset by the fresh `with_loose_path` meta.
        document.soft_close(meta.id).unwrap();
        force_conflict(&document, meta.id, ConflictState::Modified { disk_version: None });

        std::fs::rename(&src, &dst).unwrap();
        let rebound = document.rebind_for_rename(&src, &dst);
        assert_eq!(rebound.len(), 1, "the image tab must be rebound, got {rebound:?}");

        let after = document.tab_meta(meta.id).expect("rebound doc must survive");
        assert!(
            matches!(after.kind, crate::domain::document::DocumentKind::Image),
            "kind must stay Image across the rebind, got {:?}",
            after.kind
        );
        assert!(after.hidden, "a soft-closed (hidden) tab must stay hidden");
        assert!(
            after.conflict.is_active(),
            "an active conflict must survive the rebind, got {:?}",
            after.conflict
        );
        assert_eq!(after.origin.canonical_path(), Some(dst.join("pic.png").as_path()));
        assert!(
            !document.store().workers.read().contains_key(&meta.id),
            "the rebind must not spawn a compile worker for a non-Typst doc"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- §B1 soft-close / reactivate / hard-close ----------------------------

    /// `soft_close` flips the `hidden` flag but keeps the tab fully alive
    /// (worker, world, registry entry, VFS). `find_existing` still returns the
    /// hidden id — the reuse anchor for reactivate.
    #[test]
    fn soft_close_marks_hidden_but_keeps_everything_alive() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(None);
        assert!(!document.tab_meta(meta.id).unwrap().hidden);

        document.soft_close(meta.id).unwrap();

        // Flag flipped in BOTH the runtime meta and the registry.
        assert!(document.tab_meta(meta.id).unwrap().hidden, "runtime meta hidden");
        assert!(
            document.registry().read().get(meta.id).unwrap().hidden,
            "registry meta hidden"
        );
        // The tab itself is still open — still listed, still resolvable, still
        // has a worker. (Worker presence is tested indirectly: the tab is in the
        // tabs map and a subsequent reactivate must NOT spawn a new worker.)
        assert_eq!(document.list_tabs().len(), 1, "soft-close must not drop the tab");
        // find_existing for the same canonical path still resolves — that's the
        // reuse anchor. Untitled docs have no canonical path, so test via a real
        // file instead (covered by the loose-file variant below).
    }

    #[test]
    fn soft_close_keeps_canonical_find_existing_anchor_for_loose_file() {
        let (document, _compile) = make_services();
        let tmp =
            std::env::temp_dir().join(format!("ts-softclose-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "hi").unwrap();
        let meta = document.open_from_content(tmp.clone(), "hi".into(), None).unwrap();
        let canon = canonicalize_for_identity(&tmp).unwrap();

        document.soft_close(meta.id).unwrap();

        // The canonical-path index still points at the (now hidden) id — the
        // frontend reads `hidden` to decide reactivate vs fresh open.
        assert_eq!(
            document.registry().read().find_by_canonical(&canon),
            Some(meta.id),
            "hidden loose file must remain findable by canonical path"
        );
        assert!(document.registry().read().get(meta.id).unwrap().hidden);
        let _ = std::fs::remove_file(&tmp);
    }

    /// `soft_close` is idempotent and errors on a genuinely unknown id.
    #[test]
    fn soft_close_is_idempotent_and_errors_on_unknown() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(None);
        document.soft_close(meta.id).unwrap();
        document.soft_close(meta.id).unwrap(); // no-op, no panic
        assert!(document.tab_meta(meta.id).unwrap().hidden);

        let err = document.soft_close(DocumentId::new()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "unknown id must error");
    }

    /// `reactivate` flips the flag back to visible. With a cached `last_doc` it
    /// emits a `compiled` event (duration_ms: 0) WITHOUT recompiling.
    #[test]
    fn reactivate_replays_cached_compile_without_recompiling() {
        let (document, compile, emitter) = make_services_with_spy();
        let meta = document.new_tab(None);
        // Wait for the initial compile to populate last_doc.
        wait_for_compiled(&compile, meta.id);
        assert!(compile.last_doc(meta.id).is_some(), "precondition: last_doc set");

        document.soft_close(meta.id).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().hidden);

        // Reactivate: must flip visible and emit a replayed compiled event.
        // Crucially it must NOT recompile (reactivate reads last_doc, never
        // writes it). We assert the observable contract: reactivate returns
        // visible meta in both stores and leaves last_doc intact.
        let returned = document.reactivate(meta.id).unwrap();
        assert!(!returned.hidden, "reactivate must mark visible");
        assert!(
            !document.tab_meta(meta.id).unwrap().hidden,
            "runtime meta must be visible after reactivate"
        );
        assert!(
            !document.registry().read().get(meta.id).unwrap().hidden,
            "registry meta must be visible after reactivate"
        );
        // last_doc is unchanged — reactivate read it, did not reset it.
        assert!(compile.last_doc(meta.id).is_some());
        // The replayed `compiled` event was emitted for this doc (the original
        // initial-compile event plus the reactivate replay both land here).
        assert!(
            emitter.compiled_ids().contains(&meta.id),
            "reactivate should replay a compiled event for a doc with a cached last_doc"
        );
    }

    /// `reactivate` on a doc with NO cached compile (last_doc == None) still
    /// flips the flag; it just doesn't emit a compiled event (the next natural
    /// compile will fill the preview).
    #[test]
    fn reactivate_without_cached_doc_still_flips_flag() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(None);
        document.soft_close(meta.id).unwrap();
        // Don't wait for compile — but the worker may have already run. Either
        // way reactivate must succeed and return visible meta.
        let returned = document.reactivate(meta.id).unwrap();
        assert!(!returned.hidden);
    }

    /// Regression: reopening an already-open doc (the dedup branch) must
    /// replay the cached compile as a FULL `compiled` event, exactly like
    /// `reactivate`. Without it, a webview reload followed by a reopen left
    /// the frontend's page array empty, and the next incremental compile
    /// (full=false, backend cache matches the page count) never filled the
    /// holes — blank preview pages until a page-count change.
    #[test]
    fn reopen_dedup_replays_cached_compile_as_full_event() {
        let (document, compile, emitter) = make_services_with_spy();
        let dir = std::env::temp_dir()
            .join(format!("ts-dedup-replay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        let content = "#set page(width: 10cm)\n\nHello";
        std::fs::write(&path, content).unwrap();

        let meta = document
            .open_from_disk(path.clone(), content.to_string(), None)
            .unwrap();
        wait_for_compiled(&compile, meta.id);
        // Isolate the dedup reopen: drop the initial compile's events.
        emitter.clear();

        // Reopen the same path — dedup returns the SAME doc (no new tab)…
        let again = document
            .open_from_disk(path.clone(), content.to_string(), None)
            .unwrap();
        assert_eq!(again.id, meta.id, "reopen must dedup to the existing doc");

        // …and replays the cached compile as a full payload.
        let fulls = emitter.compiled_full();
        assert!(
            fulls.iter().any(|(id, full)| *id == meta.id && *full),
            "dedup reopen must emit a full compiled replay, got {fulls:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `hard_close` is the old destroy-everything behavior: the tab, worker,
    /// and registry entry are gone, and reopening mints a fresh document.
    /// `close_tab` is now a thin alias for it.
    #[test]
    fn hard_close_destroys_everything_and_releases_canonical_slot() {
        let (document, _compile) = make_services();
        let tmp =
            std::env::temp_dir().join(format!("ts-hardclose-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "x").unwrap();
        let meta = document.open_from_content(tmp.clone(), "x".into(), None).unwrap();
        let canon = canonicalize_for_identity(&tmp).unwrap();
        assert!(document.registry().read().find_by_canonical(&canon).is_some());

        document.hard_close(meta.id).unwrap();

        assert!(document.tab_meta(meta.id).is_none(), "tab must be gone");
        assert!(
            document.registry().read().find_by_canonical(&canon).is_none(),
            "canonical slot must be released so the file can be reopened fresh"
        );
        assert_eq!(document.list_tabs().len(), 0);

        // close_tab is now an alias for hard_close — same destroy semantics.
        let meta2 = document.open_from_content(tmp.clone(), "x".into(), None).unwrap();
        document.close_tab(meta2.id).unwrap();
        assert!(document.tab_meta(meta2.id).is_none());
        let _ = std::fs::remove_file(&tmp);
    }

    /// `hard_close` errors on an unknown id (mirrors the old close_tab).
    #[test]
    fn hard_close_errors_on_unknown_id() {
        let (document, _compile) = make_services();
        let err = document.hard_close(DocumentId::new()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    /// A soft-closed doc survives a subsequent `hard_close` (the LRU-eviction
    /// path): hard_close must tear down a hidden tab exactly like a visible one.
    #[test]
    fn hard_close_after_soft_close_fully_destroys() {
        let (document, _compile) = make_services();
        let meta = document.new_tab(None);
        document.soft_close(meta.id).unwrap();
        assert!(document.tab_meta(meta.id).unwrap().hidden);

        document.hard_close(meta.id).unwrap();
        assert!(document.tab_meta(meta.id).is_none());
        assert!(document.registry().read().get(meta.id).is_none());
    }

    /// Regression: deleting an open file must HARD-CLOSE its doc so the watcher
    /// can't keep poking it. Before the fix, `delete_entry` only marked the doc
    /// `Missing` (a zombie: still in `tabs`, still in the registry), so the
    /// watcher's later `handle_external_change` for the deleted path resolved to
    /// that doc and — on Windows, where the trash op emits intermediate events —
    /// misclassified the delete as `Modified`, surfacing a spurious conflict
    /// dialog. After hard-closing, the registry slot is gone, so the watcher
    /// resolves no open document and is a no-op: no zombie, no conflict.
    #[test]
    fn hard_close_then_external_change_is_noop() {
        let (document, _compile) = make_services();
        let tmp = std::env::temp_dir()
            .join(format!("ts-del-noconflict-{}.typ", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, "x").unwrap();
        let meta = document.open_from_content(tmp.clone(), "x".into(), None).unwrap();
        let canon = canonicalize_for_identity(&tmp).unwrap();
        assert!(document.registry().read().find_by_canonical(&canon).is_some());

        // Simulate the delete path: trash the file, then hard-close the doc
        // (exactly what `delete_entry` now does via `hard_close_affected`).
        let _ = std::fs::remove_file(&tmp);
        document.hard_close(meta.id).unwrap();

        // No zombie: the doc and its registry slot are gone.
        assert!(document.tab_meta(meta.id).is_none());
        assert!(
            document.registry().read().find_by_canonical(&canon).is_none(),
            "registry slot must be released so the watcher resolves no open doc"
        );

        // The watcher fires for the now-deleted path. With the registry slot
        // gone, `handle_external_change_locked` resolves no open document and
        // returns without marking anything — no panic, no resurrected tab.
        handle_external_change_locked(
            &tmp,
            &document.store.tabs,
            &document.store.registry,
            &document.store.emitter,
        );
        assert!(
            document.store.tabs.read().get(&meta.id).is_none(),
            "watcher must not resurrect the hard-closed doc"
        );
    }

    /// Regression for the "self-save misreported as an external change" race.
    ///
    /// When a keystroke's `update_text` lands between the atomic write
    /// completing and `mark_saved` running, the buffer's revision advances
    /// past the saved one. `mark_saved`'s CAS must then keep `dirty` true
    /// (the newer edit is still unsaved) — BUT it must STILL re-baseline the
    /// stored disk version to the bytes just written. Without that re-baseline
    /// the next watcher poll compares the stale stored version against the
    /// freshly written disk bytes, sees a mismatch, and spuriously reports a
    /// `Modified` conflict for our own save. This locks the fix in place.
    #[test]
    fn mark_saved_rebaselines_disk_version_when_revision_advances() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir()
            .join(format!("ts-marksaved-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "v0").unwrap();

        // Open: disk_version seeded to hash("v0"); revision 0; clean.
        let meta = document
            .open_from_content(path.clone(), "v0".into(), None)
            .unwrap();
        let id = meta.id;

        // User types "v1" → dirty, revision 1.
        document.update_text(id, "v1".into()).unwrap();
        let saved_revision = document.tab_revision(id).unwrap();

        // The save's atomic write lands "v1" on disk.
        std::fs::write(&path, "v1").unwrap();

        // RACE: while the write was in flight, another keystroke ("v2") lands —
        // the buffer revision advances past `saved_revision` BEFORE mark_saved
        // runs.
        document.update_text(id, "v2".into()).unwrap();
        assert!(
            document.tab_revision(id).unwrap() > saved_revision,
            "test setup: revision must advance past the saved one"
        );

        // mark_saved(saved_revision): dirty stays true (CAS), but the stored
        // disk version must be re-baselined to the bytes on disk now.
        document.mark_saved(id, saved_revision);

        // (a) dirty retained — the "v2" edit is still unsaved.
        assert!(
            document.tab_meta(id).unwrap().dirty,
            "dirty must stay true when revision advanced during save"
        );

        // (b) disk_version rebaselined to the bytes actually on disk.
        let on_disk = DiskVersion::from_path(&path).unwrap();
        let tab = document
            .store
            .tabs
            .read()
            .get(&id)
            .cloned()
            .expect("tab present");
        {
            let rt = tab.state.lock();
            assert_eq!(
                rt.disk_version,
                Some(on_disk),
                "disk_version must reflect the bytes just written, not the pre-save baseline"
            );
        }

        // (c) End-to-end: the watcher fires for our own save. With the
        //     rebaselined version it is recognized as a self-save no-op — no
        //     conflict may be raised.
        handle_external_change_locked(
            &path,
            &document.store.tabs,
            &document.store.registry,
            &document.store.emitter,
        );
        {
            let rt = tab.state.lock();
            assert!(
                matches!(rt.meta.conflict, ConflictState::None),
                "self-save must not trip a conflict, got {:?}",
                rt.meta.conflict
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression for the save_overwrite conflict-clear gap.
    ///
    /// When the user picks "overwrite disk" (save_overwrite), the write
    /// succeeds and mark_saved runs. If a keystroke's update_text lands during
    /// the write, the CAS fails — dirty correctly stays true (the newer edit is
    /// unsaved) — but the conflict must STILL be cleared: the disk was just
    /// overwritten, so the prior external-change conflict is resolved. Without
    /// this, the stale conflict blocks the next in-place save at the conflict
    /// gate. Mirrors the disk_version re-baseline fix one rung over on the same
    /// CAS.
    #[test]
    fn mark_saved_clears_conflict_unconditionally_when_revision_advances() {
        let (document, _compile) = make_services();
        let dir = std::env::temp_dir()
            .join(format!("ts-marksaved-conflict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.typ");
        std::fs::write(&path, "v0").unwrap();

        let meta = document
            .open_from_content(path.clone(), "v0".into(), None)
            .unwrap();
        let id = meta.id;

        // Tab is now in a Modified conflict (as if the watcher saw an external
        // change) with an unsaved buffer edit at revision 1 — the state at the
        // moment save_overwrite captures its snapshot.
        document.update_text(id, "v1".into()).unwrap();
        let saved_revision = document.tab_revision(id).unwrap();
        {
            let tab = document.store.tabs.read().get(&id).cloned().unwrap();
            tab.state.lock().meta.conflict =
                ConflictState::Modified { disk_version: None };
        }

        // save_overwrite's atomic write lands "v1" on disk.
        std::fs::write(&path, "v1").unwrap();

        // RACE: a keystroke lands during the write → revision advances past
        // saved_revision before mark_saved runs.
        document.update_text(id, "v2".into()).unwrap();
        assert!(
            document.tab_revision(id).unwrap() > saved_revision,
            "test setup: revision must advance past the saved one"
        );

        document.mark_saved(id, saved_revision);

        // dirty retained — the "v2" edit is still unsaved.
        assert!(
            document.tab_meta(id).unwrap().dirty,
            "dirty must stay true when revision advanced during save"
        );

        // conflict cleared — the overwrite resolved it, even though the buffer
        // advanced. A stale conflict here would block the next Ctrl+S.
        let tab = document.store.tabs.read().get(&id).cloned().unwrap();
        {
            let rt = tab.state.lock();
            assert!(
                matches!(rt.meta.conflict, ConflictState::None),
                "conflict must be cleared after a successful overwrite even when \
                 the buffer advanced, got {:?}",
                rt.meta.conflict
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
