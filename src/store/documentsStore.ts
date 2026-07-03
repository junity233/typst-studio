import { create } from "zustand";
import type { CompileStatus } from "../lib/ui-types";
import type { ConflictState, LineRect, OpenedDocument } from "../lib/types";

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
  /** Monotonic content revision; bumped on every edit (§7). */
  revision: number;
  /**
   * External-modification conflict state (§8.4). "modified" when the disk
   * changed while the buffer had unsaved edits; "missing" when the backing
   * file was deleted. Reset to "none" on user edit (they're moving past it).
   */
  conflict: ConflictState;
  status: CompileStatus;
  durationMs: number | null;
  svgPages: string[];
  /** Source line → preview-page bbox, from the last `compiled` event. */
  lineMap: LineRect[];
}

/** A blank document seeded from a freshly-opened document payload. */
export function documentFromOpened(doc: OpenedDocument): Document {
  return {
    id: doc.id,
    title: doc.title,
    path: doc.path,
    dirty: doc.dirty,
    content: doc.content,
    // The backend seeds revision 0 on open; the first compile carries revision
    // 0 and matches this. Each subsequent edit bumps it.
    revision: 0,
    // No external-modification conflict on open (§8.4).
    conflict: "none",
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
  };
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
  ) => void;
  /**
   * Set a document's external-modification conflict state (§8.4). A simple
   * setter — the conflict state is not revision-tagged.
   */
  setConflict: (id: string, conflict: ConflictState) => void;
  /** Clear dirty + (re)bind path on a successful save (also clears conflict). */
  markSaved: (id: string, path: string) => void;
  /** Re-mark a document dirty (session-restore path). */
  reMarkDirty: (id: string) => void;
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
      // Reset conflict to "none" (§8.4): the user is editing, so they're moving
      // past any prior external-change conflict.
      return {
        documents: {
          ...s.documents,
          [id]: {
            ...doc,
            content,
            dirty: true,
            revision: doc.revision + 1,
            conflict: "none",
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

  setPages: (id, revision, svgPages, lineMap) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      // §7: discard stale-revision preview. Without this guard, a slow compile
      // of an older buffer could clobber a newer preview.
      if (revision < doc.revision) return s;
      return {
        documents: { ...s.documents, [id]: { ...doc, svgPages, lineMap } },
      };
    }),

  setConflict: (id, conflict) =>
    set((s) => {
      const doc = s.documents[id];
      if (!doc) return s;
      return { documents: { ...s.documents, [id]: { ...doc, conflict } } };
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
            // A successful save resolves any external-change conflict (§8.4):
            // the buffer is now in sync with disk.
            conflict: "none",
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

  getDocument: (id) => get().documents[id],
}));
