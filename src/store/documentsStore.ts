import { create } from "zustand";
import type { CompileStatus } from "../lib/ui-types";
import type {
  ConflictState,
  DocumentOrigin,
  LineRect,
  OpenedDocument,
  OutlineNode,
} from "../lib/types";

/**
 * Phase 4 (design §10): domain state for open documents, kept SEPARATE from
 * view state (tab order, active view, panel layout — those live in the views
 * store [`tabsStore`](./tabsStore.ts)).
 *
 * This store is a normalized `documents: Record<DocumentId, Document>` keyed by
 * id. It holds the per-document domain state that was previously inlined on
 * each `Tab` object: origin/path, dirty, content revision, compile status +
 * diagnostics/preview, and external-modification conflict. A view (an entry in
 * the views store's id list) references a document purely by `documentId` — it
 * does NOT copy content/path/dirty/compile results.
 *
 * ## Revision guard (§7)
 *
 * `revision` is the authoritative content version, bumped optimistically on
 * every [`updateContent`](Self.updateContent). Compile events are tagged with a
 * revision; `setPages`/`setStatus` discard events whose revision is strictly
 * older than the document's current revision, so a slow compile can never
 * overwrite a newer preview.
 */

/**
 * A single open document's domain state. `svgPages` holds the rendered preview
 * pages emitted by the backend; `lineMap` is the matching source-line →
 * page-rect index used for scroll-sync and click-to-source.
 */
export interface Document {
  id: string;
  title: string;
  path: string | null;
  dirty: boolean;
  content: string;
  /**
   * Authoritative disk classification (§4.2 / §17). The LSP refactor needs
   * `DocumentOrigin` on the frontend domain object so
   * [`documentUri.ts`](../components/Editor/documentUri.ts) can convert it to
   * the URI Monaco + Tinymist both see, without an IPC round-trip. The backend
   * remains the source of truth; this field is a coherent mirror kept in sync
   * by [`documentFromOpened`](Self.documentFromOpened) /
   * [`markSaved`](Self.markSaved) / [`rebindDocPath`](Self.rebindDocPath) so
   * the model registry can derive the new URI after a Save As / rename.
   */
  origin: DocumentOrigin;
  /** Monotonic content revision; bumped on every edit (§7). */
  revision: number;
  /**
   * The revision the LAST APPLIED compile was stamped with (i.e. the revision
   * whose `svgPages`/`lineMap` are currently shown). Bumped in lockstep with
   * `revision` at open (`documentFromOpened`); updated to the applied compile's
   * revision in `setPages`. While `compiledRevision < revision` the buffer has
   * edits the preview hasn't caught up to — its `lineMap` is stale and scroll-
   * sync must NOT re-align against it (the target would be wrong). The gap
   * widens during fast typing (compile results come back stamped with an older
   * revision and are discarded by the §7 guard) and closes when a fresh
   * compile lands after typing settles.
   */
  compiledRevision: number;
  /**
   * External-modification conflict state (§5.4 / §8.4). One of
   * "modified"/"missing"/"permission_changed"/"replaced" when the watcher
   * detected a disk change that could not be auto-applied; "none" otherwise.
   * Per §8.4, user typing does NOT auto-clear this — only explicit resolution
   * actions (use-disk / overwrite / save-as / discard) clear it.
   */
  conflict: ConflictState;
  /**
   * The disk content captured at conflict-detection time (§5.4), present on
   * "modified" so the ConflictDialog can show a side-by-side compare without a
   * second IPC round-trip. `null` for the other variants (no readable disk
   * version to diff against). Set by `setConflict`; cleared when conflict is
   * resolved.
   */
  conflictDiskContent: string | null;
  status: CompileStatus;
  durationMs: number | null;
  svgPages: string[];
  /** Source line → preview-page bbox, from the last `compiled` event. */
  lineMap: LineRect[];
  /** Document heading outline (§Outline view), from the last `compiled` event. */
  outline: OutlineNode[];
}

/** A blank document seeded from a freshly-opened document payload. */
export function documentFromOpened(doc: OpenedDocument): Document {
  return {
    id: doc.id,
    title: doc.title,
    path: doc.path,
    dirty: doc.dirty,
    content: doc.content,
    // Authoritative origin mirrored from the backend payload (§17). The backend
    // is the source of truth; this mirror lets documentUri.ts derive the URI
    // without a round-trip.
    origin: doc.origin,
    // The backend seeds revision 0 on open; the first compile carries revision
    // 0 and matches this. Each subsequent edit bumps it.
    revision: 0,
    // No compile has landed yet at open; `compiledRevision` starts equal to
    // `revision` so scroll-sync treats the (empty) preview as in-sync until the
    // first real compile, rather than permanently suppressing alignment.
    compiledRevision: 0,
    // No external-modification conflict on open (§8.4).
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
  };
}

/**
 * Derive the post-save `origin` for [`markSaved`](Self.markSaved) (§17). The
 * backend is authoritative, but the frontend mirror must stay coherent so the
 * model registry can derive the new URI without a round-trip.
 *
 * - Path unchanged: keep the variant, but sync the inner path (defensive — the
 *   canonical path may have re-cased on case-insensitive FSes).
 * - Path changed (Save As): the doc lands at a new disk location. An untitled
 *   doc becomes a `looseFile` rooted at the new file's parent directory (a Save
 *   As target is by definition outside any open workspace's tracking, so
 *   `looseFile` is the correct classification until the backend reclassifies).
 *   A `workspaceFile`/`looseFile` whose path changed also re-roots to the new
 *   parent and drops to `looseFile` (the backend re-classifies to workspaceFile
 *   on its next meta push if the new path is inside a workspace).
 */
function nextOriginAfterSave(
  origin: DocumentOrigin,
  oldPath: string | null,
  newPath: string,
): DocumentOrigin {
  if (oldPath !== null && oldPath === newPath) {
    // Plain save (no path change): keep variant, keep inner path in sync.
    return origin.kind === "untitled" ? origin : { ...origin, path: newPath };
  }
  // Save As: re-root to the new parent dir as a looseFile.
  return {
    kind: "looseFile",
    path: newPath,
    root: parentDir(newPath),
  };
}

/**
 * Derive the post-rename `origin` for [`rebindDocPath`](Self.rebindDocPath)
 * (§6.4 / §17): update the inner `path` to the new location, preserving the
 * variant and its `workspace_id` / `root`. Not called for untitled docs.
 */
function rebindOriginPath(
  origin: DocumentOrigin,
  newPath: string,
): DocumentOrigin {
  switch (origin.kind) {
    case "workspaceFile":
      return { ...origin, path: newPath };
    case "looseFile":
      return { ...origin, path: newPath };
    case "untitled":
      // rebindDocPath is not invoked for untitled docs (they have no path).
      return origin;
  }
}

/**
 * Canonical parent directory of an absolute path. Cross-platform: splits on
 * either separator. Used to root a Save-As looseFile at its new parent dir.
 */
function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return p; // no separator, or root — keep as-is.
  return p.slice(0, idx);
}

/**
 * Actions over the normalized documents map. These mirror the mutations that
 * previously lived on the tabs store (revision-guarded compile updates, dirty
 * flips, conflict, save) but operate on `documents` by id.
 */
export interface DocumentsState {
  documents: Record<string, Document>;
  /** Insert a document into the map (called by the views-store open actions). */
  openDocument: (doc: OpenedDocument) => void;
  /** Insert a document built from explicit fields (untitled open path). */
  upsertDocument: (doc: Document) => void;
  /** Remove a document from the map (called by the views-store close action). */
  closeDocument: (id: string) => void;
  /** Update content and bump the revision (§7). No-op if unchanged. */
  updateContent: (id: string, content: string) => void;
  /** Apply a compile status tagged with `revision`; stale revisions ignored. */
  setStatus: (
    id: string,
    revision: number,
    status: CompileStatus,
    durationMs?: number,
  ) => void;
  /** Replace preview pages tagged with `revision`; stale revisions ignored. */
  setPages: (
    id: string,
    revision: number,
    svgPages: string[],
    lineMap: LineRect[],
    outline: OutlineNode[],
  ) => void;
  /**
   * Set a document's external-modification conflict state (§5.4 / §8.4). A
   * simple setter — the conflict state is not revision-tagged. The optional
   * `diskContent` (present on "modified") is stashed on the doc so the
   * ConflictDialog can show a compare view without a second IPC round-trip;
   * passing `null` (or omitting) clears any previously-stashed disk content.
   */
  setConflict: (
    id: string,
    conflict: ConflictState,
    diskContent?: string | null,
  ) => void;
  /** Clear dirty + (re)bind path on a successful save (also clears conflict). */
  markSaved: (id: string, path: string) => void;
  /** Re-mark a document dirty (session-restore path). */
  reMarkDirty: (id: string) => void;
  /**
   * Rebind a document's path after a rename/move (§6.4 联动). Updates `path` +
   * `title` (derived from the new path's basename) WITHOUT touching dirty /
   * content / revision (the buffer is preserved across the rename — only the
   * disk location changed). Used by the `docs_rebound` event handler so tab
   * titles, breadcrumbs, and the active-file highlight track the rename.
   */
  rebindDocPath: (id: string, newPath: string) => void;
  /** Read-only lookup. */
  getDocument: (id: string) => Document | undefined;
}

export const useDocumentsStore = create<DocumentsState>()((set, get) => ({
  documents: {},

  openDocument: (doc) =>
    set((s) => ({
      documents: { ...s.documents, [doc.id]: documentFromOpened(doc) },
    })),

  upsertDocument: (doc) =>
    set((s) => ({ documents: { ...s.documents, [doc.id]: doc } })),

  closeDocument: (id) =>
    set((s) => {
      if (!(id in s.documents)) return s;
      const next = { ...s.documents };
      delete next[id];
      return { documents: next };
    }),

  updateContent: (id, content) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc || content === doc.content) return s;
      // Bump the optimistic revision. The backend's next compile event will
      // carry this same revision (or higher); older events are then ignored.
      //
      // §8.4 / §5.4 FIX: do NOT reset `conflict` here. The previous version
      // cleared conflict on every edit, which silently swallowed an
      // unresolved external change ("用户继续输入不能自动清除 conflict"). Only
      // explicit resolution actions (use-disk / overwrite / save-as / discard)
      // clear the flag — see setConflict / markSaved / clearConflict. This
      // means a conflicted doc the user keeps typing in STAYS conflicted (and
      // the in-place save gate keeps blocking) until they resolve it.
      return {
        documents: {
          ...s.documents,
          [id]: {
            ...doc,
            content,
            dirty: true,
            revision: doc.revision + 1,
          },
        },
      };
    }),

  setStatus: (id, revision, status, durationMs) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      // §7: discard stale-revision status. A strictly-older revision means a
      // newer edit already superseded this compile — never overwrite the UI.
      if (revision < doc.revision) return s;
      return {
        documents: {
          ...s.documents,
          [id]: { ...doc, status, durationMs: durationMs ?? doc.durationMs },
        },
      };
    }),

  setPages: (id, revision, svgPages, lineMap, outline) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      // §7: discard stale-revision preview. Without this guard, a slow compile
      // of an older buffer could clobber a newer preview.
      if (revision < doc.revision) return s;
      return {
        documents: {
          ...s.documents,
          [id]: {
            ...doc,
            svgPages,
            lineMap,
            outline,
            // Record that the shown preview now reflects this revision. While
            // `revision` (bumped on every keystroke) outruns this, the lineMap
            // is stale and scroll-sync must suppress re-alignment.
            compiledRevision: revision,
          },
        },
      };
    }),

  setConflict: (id, conflict, diskContent = null) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      return {
        documents: {
          ...s.documents,
          [id]: {
            ...doc,
            conflict,
            // Stash the disk content for the compare view; clear it when the
            // conflict resolves to "none" so stale content doesn't linger.
            conflictDiskContent: conflict === "none" ? null : diskContent,
          },
        },
      };
    }),

  markSaved: (id, path) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      return {
        documents: {
          ...s.documents,
          [id]: {
            ...doc,
            path,
            title: path.split(/[\\/]/).pop() ?? doc.title,
            dirty: false,
            // §17 origin coherence: the backend is authoritative, but the
            // frontend mirror must stay coherent so the model registry can
            // derive the new URI without a round-trip. On a Save As (path
            // changed) an untitled doc becomes a looseFile rooted at the new
            // file's parent directory (canonical absolute). A workspaceFile /
            // looseFile changing location also re-roots to the new parent.
            origin: nextOriginAfterSave(doc.origin, doc.path, path),
            // A successful save resolves any external-change conflict (§8.4):
            // the buffer is now in sync with disk. Also drop the stashed disk
            // content — there's nothing left to compare.
            conflict: "none",
            conflictDiskContent: null,
          },
        },
      };
    }),

  reMarkDirty: (id) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      return { documents: { ...s.documents, [id]: { ...doc, dirty: true } } };
    }),

  rebindDocPath: (id, newPath) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      // Untitled docs have no disk path to rebind; calling this on one would
      // create an incoherent mirror (path set, origin still untitled). The
      // backend never sends docs_rebound for untitled docs, but guard anyway.
      if (doc.origin.kind === "untitled") return s;
      return {
        documents: {
          ...s.documents,
          [id]: {
            ...doc,
            path: newPath,
            // §17 origin coherence: keep the inner path in sync with the new
            // location, preserving the variant + (workspace_id | root). Not
            // called for untitled docs (they have no path to rebind).
            origin: rebindOriginPath(doc.origin, newPath),
            // Title is the new path's basename (matches the backend's
            // DocumentMeta derivation). Dirty/content/revision/conflict are all
            // preserved — a rename moves the file, not the edits.
            title: newPath.split(/[\\/]/).pop() ?? doc.title,
          },
        },
      };
    }),

  getDocument: (id) => get().documents[id],
}));
