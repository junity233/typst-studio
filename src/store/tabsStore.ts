import { create } from "zustand";
import type { CompileStatus } from "../lib/ui-types";
import type { ConflictState, LineRect, OpenedDocument, OutlineNode } from "../lib/types";
import {
  closeTab as closeTabBE,
  newTab as newTabBE,
} from "../lib/tauri";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { captureAndSaveSession, recordFile } from "../lib/session";
import {
  documentFromOpened,
  useDocumentsStore,
  type Document,
} from "./documentsStore";
import { useSaveStateStore } from "./saveStateStore";

/**
 * Phase 4 (design §10): the **views store**. This holds ONLY view state — the
 * ordered list of open document ids (`tabs`) and the active view (`activeId`) —
 * and delegates every domain mutation (content, path, dirty, revision, compile
 * status/diagnostics/preview, conflict) to the normalized
 * [`documentsStore`](./documentsStore.ts).
 *
 * A view entry is just a `DocumentId` reference; the actual document lives in
 * the documents map. The two stores are kept in lock-step by the coordinated
 * open/close actions below: opening a document inserts it into the documents
 * map AND appends its id to the views list; closing removes it from both.
 *
 * ## Why a separate `Tab` type alias?
 *
 * Several component props (e.g. `MonacoEditor`) are typed `tab: Tab`. To avoid
 * a mechanical rename across the component tree, `Tab` is re-exported here as
 * an alias of [`Document`] — the domain object read from `documentsStore`. New
 * code should read domain fields from `documentsStore` by id and reach for the
 * views store only for ordering / activation.
 */

/** Backward-compat alias: a "Tab" prop is now the domain `Document`. */
export type Tab = Document;

export interface TabsState {
  /** Ordered list of open document ids (the view order). */
  tabs: string[];
  activeId: string | null;
  /** Create an untitled tab via the backend; returns the new tab id. */
  openTab: (content?: string) => Promise<string>;
  /** Add an already-opened (file-backed) document to the store. */
  openPath: (doc: OpenedDocument) => void;
  /** Close on the backend, then drop the local tab. */
  closeTab: (id: string) => Promise<void>;
  /** Activate a view by id (no-op if the id isn't an open view). */
  activate: (id: string) => void;
  /** Update content and bump the revision (§7). Delegates to documentsStore. */
  updateContent: (id: string, content: string) => void;
  /** Apply a compile status tagged with `revision`. Delegates to documentsStore. */
  setStatus: (
    id: string,
    revision: number,
    status: CompileStatus,
    durationMs?: number,
  ) => void;
  /** Replace preview pages tagged with `revision`. Delegates to documentsStore. */
  setPages: (
    id: string,
    revision: number,
    svgPages: string[],
    lineMap: LineRect[],
    outline: OutlineNode[],
  ) => void;
  /**
   * Set a document's conflict state (§5.4 / §8.4). Delegates to documentsStore.
   * The optional `diskContent` is stashed for the ConflictDialog compare view.
   */
  setConflict: (
    id: string,
    conflict: ConflictState,
    diskContent?: string | null,
  ) => void;
  /** Clear dirty + rebind path on save. Delegates to documentsStore. */
  markSaved: (id: string, path: string) => void;
}

export const DEFAULT_CONTENT =
  "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: async (content) => {
    // Backend auto-compiles on new_tab, so the initial preview arrives via
    // the `compiled` event — no need for a separate updateText round-trip.
    const doc = await newTabBE(content);
    useDocumentsStore.getState().openDocument(doc);
    set((s) => ({ tabs: [...s.tabs, doc.id], activeId: doc.id }));
    void captureAndSaveSession();
    return doc.id;
  },

  openPath: (doc) => {
    useDocumentsStore.getState().openDocument(doc);
    set((s) => ({ tabs: [...s.tabs, doc.id], activeId: doc.id }));
    // Remember the opened file so it can be restored on next launch.
    if (doc.path) recordFile(doc.path);
    void captureAndSaveSession();
  },

  closeTab: async (id) => {
    try {
      await closeTabBE(id);
    } catch (e) {
      // Backend may reject (already gone); still drop the local tab.
      console.warn("[closeTab] backend rejected:", e);
    }
    useDiagnosticsStore.getState().clear(id);
    useDocumentsStore.getState().closeDocument(id);
    useSaveStateStore.getState().clear(id);
    set((s) => {
      const tabs = s.tabs.filter((tabId) => tabId !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      }
      return { tabs, activeId };
    });
    // Await so the close-guard (useAppCommands) can await closeTab and have the
    // session capture complete before destroying the window.
    await captureAndSaveSession();
  },

  activate: (id) => {
    if (get().tabs.includes(id)) {
      set({ activeId: id });
      void captureAndSaveSession();
    }
  },

  // --- domain mutations: thin delegation to documentsStore ------------------

  updateContent: (id, content) =>
    useDocumentsStore.getState().updateContent(id, content),

  setStatus: (id, revision, status, durationMs) =>
    useDocumentsStore.getState().setStatus(id, revision, status, durationMs),

  setPages: (id, revision, svgPages, lineMap, outline) =>
    useDocumentsStore.getState().setPages(id, revision, svgPages, lineMap, outline),

  setConflict: (id, conflict, diskContent) =>
    useDocumentsStore.getState().setConflict(id, conflict, diskContent),

  markSaved: (id, path) => {
    useDocumentsStore.getState().markSaved(id, path);
    // Refresh the session's last-file hint on every save (covers Save, Save
    // As, and the close-guard Save-All), so relaunch reopens the latest file.
    recordFile(path);
    void captureAndSaveSession();
  },
}));

// --- view ↔ document selectors ---------------------------------------------

/**
 * Read the domain object for the active view, or `null` if none. Components
 * that previously did `useTabsStore((s) => s.tabs.find((t) => t.id ===
 * s.activeId))` should use this instead — it subscribes to the documents map so
 * edits/compiles re-render correctly.
 */
export function useActiveDocument(): Document | null {
  const activeId = useTabsStore((s) => s.activeId);
  return useDocumentsStore((s) =>
    activeId !== null ? (s.documents[activeId] ?? null) : null,
  );
}

/**
 * Read the domain object for a specific view id, subscribing to updates.
 */
export function useDocument(id: string | null | undefined): Document | null {
  return useDocumentsStore((s) =>
    id !== null && id !== undefined ? (s.documents[id] ?? null) : null,
  );
}

/**
 * Snapshot the active document id + domain object for session capture. Reads
 * both stores once (no subscription). Returns `null` content-bearing entries as
 * `CaptureTab`s so [`session.ts`] can serialize them without a static import of
 * the documents store.
 */
export function readOrderedDocuments(): {
  id: string;
  path: string | null;
  content: string;
  dirty: boolean;
}[] {
  const ids = useTabsStore.getState().tabs;
  const docs = useDocumentsStore.getState().documents;
  return ids
    .map((id) => {
      const d = docs[id];
      if (!d) return null;
      return { id: d.id, path: d.path, content: d.content, dirty: d.dirty };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

let initStarted = false;
let initDone = false;

/**
 * Ensure at least one tab exists on app startup. Idempotent and guarded
 * against React strict-mode double effect invocation.
 */
export async function initTabs(): Promise<void> {
  if (initStarted || initDone) return;
  initStarted = true;
  try {
    if (useTabsStore.getState().tabs.length === 0) {
      await useTabsStore.getState().openTab();
    }
    initDone = true;
  } finally {
    initStarted = false;
  }
}

// Re-export so callers that build a Document from outside (session restore)
// can share the canonical constructor.
export { documentFromOpened };
