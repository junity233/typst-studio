import { create } from "zustand";
import type { CompileStatus } from "../lib/ui-types";
import type {
  ChangedPage,
  ConflictState,
  DocumentKind,
  LineRect,
  OpenedDocument,
  OutlineNode,
} from "../lib/types";
import {
  hardCloseTab as hardCloseTabBE,
  newTab as newTabBE,
  reactivateTab as reactivateTabBE,
  softCloseTab as softCloseTabBE,
  updateText,
} from "../lib/tauri";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { captureAndSaveSession, recordFile } from "../lib/session";
import {
  documentFromOpened,
  useDocumentsStore,
  type Document,
} from "./documentsStore";
import { useSaveStateStore } from "./saveStateStore";
import { readSetting } from "../hooks/useSetting";

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
  /**
   * Soft-closed document ids (Phase B2), in LRU order: index 0 = oldest
   * (next to be evicted). These tabs have left the strip but their backend
   * state (worker/world/compile result) AND frontend state (documents[id]
   * entry, Monaco model) all survive — reopening the file re-activates the
   * hidden doc instantly. Capped at `MAX_HIDDEN`; overflow hard-closes the
   * oldest (true destroy, frees the worker).
   */
  hidden: string[];
  activeId: string | null;
  /** Create an untitled tab via the backend; returns the new tab id. */
  openTab: (content?: string) => Promise<string>;
  /** Add an already-opened (file-backed) document to the store. */
  openPath: (doc: OpenedDocument) => void;
  /**
   * Close a tab. By default (Phase B2) this soft-closes: the tab leaves the
   * strip and its backend state is hidden (kept alive) rather than destroyed.
   * `closeTabWithConfirm` (the X button) routes through here. True destruction
   * (releasing the worker) happens via [`hardClose`] — used for LRU eviction.
   */
  closeTab: (id: string) => Promise<void>;
  /**
   * Soft-close a tab (Phase B2): the tab leaves the strip but its backend +
   * frontend state survives (kept in [`hidden`]). If `hidden` exceeds
   * `MAX_HIDDEN`, the oldest hidden doc is hard-closed (LRU eviction).
   */
  softClose: (id: string) => Promise<void>;
  /**
   * Reactivate a soft-closed (hidden) document (Phase B2): move it back to the
   * strip and make it active. The backend replays its cached compiled result.
   */
  reactivate: (id: string) => Promise<void>;
  /**
   * Hard-close a document (Phase B2): the true destroy — remove from
   * `tabs`/`hidden`, delete the documents[id] entry, and release the backend
   * worker/world. Used for LRU eviction of soft-closed docs; not recoverable.
   */
  hardClose: (id: string) => Promise<void>;
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
  /** Replace/merge preview pages tagged with `revision`. Delegates to documentsStore. */
  setPages: (
    id: string,
    revision: number,
    pageCount: number,
    full: boolean,
    changedPages: ChangedPage[],
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
  markSaved: (id: string, path: string, savedRevision?: number) => void;
}

export const DEFAULT_CONTENT =
  "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

/**
 * Maximum number of soft-closed (hidden) docs retained for instant reactivation
 * (Phase B2 LRU). When `hidden` would exceed this, the oldest hidden doc is
 * hard-closed (true destroy, freeing its worker).
 */
export const MAX_HIDDEN = 10;

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  hidden: [],
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
    set((s) => {
      // If the doc was soft-closed (in hidden) and is being re-added via a
      // non-dedup path (e.g. openFileByPath → openPath), remove it from hidden
      // so it doesn't appear in both arrays. Belt-and-suspenders against the
      // backend handing back a hidden flag; the backend's open-from-* now
      // clears it too, but this guarantees the frontend invariant regardless.
      const hidden = s.hidden.filter((h) => h !== doc.id);
      const tabs = s.tabs.includes(doc.id) ? s.tabs : [...s.tabs, doc.id];
      return { tabs, hidden, activeId: doc.id };
    });
    // Remember the opened file so it can be restored on next launch.
    if (doc.path) recordFile(doc.path);
    void captureAndSaveSession();
    // Guarantee a compile fires whose result the frontend can receive. The
    // backend already triggers an initial compile on open (create_worker →
    // recompile), but the frontend's `compiled` listener attaches
    // asynchronously (useTypstCompile awaits onCompiled), so it may miss that
    // first event — leaving the preview empty until the user types. Re-pushing
    // the same content+revision makes the backend treat it as a recompile
    // (same revision + same content → refresh, document_service.rs:1256), so
    // no spurious edit/revision bump occurs. Skipped for non-Typst kinds
    // (image/pdf/text/markdown don't compile).
    if ((doc.kind ?? "typst") === "typst") {
      void updateText(doc.id, doc.content, doc.revision).catch((e) =>
        console.warn("[openPath] initial recompile failed:", e),
      );
    }
  },

  closeTab: async (id) => {
    // Phase B2: the X button (via closeTabWithConfirm) now soft-closes by
    // default — the tab leaves the strip but its state survives for instant
    // reactivation. True destruction (releasing the worker) is hardClose,
    // used for LRU eviction.
    await get().softClose(id);
  },

  softClose: async (id) => {
    try {
      await softCloseTabBE(id);
    } catch (e) {
      // Backend may reject (already gone); still hide the local tab.
      console.warn("[softClose] backend rejected:", e);
    }
    // Compute the LRU eviction list BEFORE set (cleaner than reading it back
    // out of state). newest goes at the end of hidden; if that overflows the
    // `tabs.maxHidden` setting, the oldest (front) entries are evicted
    // (hard-closed). Read live so a settings change takes effect on the next
    // soft-close.
    const maxHidden = readSetting<number>("tabs.maxHidden", MAX_HIDDEN);
    const prevHidden = get().hidden;
    const nextHiddenAll = [...prevHidden, id];
    const evict =
      nextHiddenAll.length > maxHidden
        ? nextHiddenAll.slice(0, nextHiddenAll.length - maxHidden)
        : [];
    const hidden =
      nextHiddenAll.length > maxHidden
        ? nextHiddenAll.slice(nextHiddenAll.length - maxHidden)
        : nextHiddenAll;
    set((s) => {
      const tabs = s.tabs.filter((tabId) => tabId !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      }
      return { tabs, activeId, hidden };
    });
    // Hard-close evicted docs AFTER set (avoids reentrant set). True destroy:
    // frees the worker + deletes the documents[id] entry.
    await Promise.all(evict.map((eid) => get().hardClose(eid)));
    // Await so the close-guard (useAppCommands) can await closeTab and have the
    // session capture complete before destroying the window.
    await captureAndSaveSession();
  },

  reactivate: async (id) => {
    try {
      await reactivateTabBE(id);
    } catch (e) {
      // Backend may reject (already visible / unknown); still restore locally.
      console.warn("[reactivate] backend rejected:", e);
    }
    set((s) => ({
      hidden: s.hidden.filter((h) => h !== id),
      tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
      activeId: id,
    }));
    void captureAndSaveSession();
  },

  hardClose: async (id) => {
    try {
      await hardCloseTabBE(id);
    } catch (e) {
      // Backend may reject (already gone); still drop the local tab.
      console.warn("[hardClose] backend rejected:", e);
    }
    useDiagnosticsStore.getState().clearAll(id);
    useDocumentsStore.getState().closeDocument(id);
    useSaveStateStore.getState().clear(id);
    set((s) => {
      const tabs = s.tabs.filter((tabId) => tabId !== id);
      const hidden = s.hidden.filter((h) => h !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      }
      return { tabs, hidden, activeId };
    });
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

  setPages: (id, revision, pageCount, full, changedPages, lineMap, outline) =>
    useDocumentsStore
      .getState()
      .setPages(id, revision, pageCount, full, changedPages, lineMap, outline),

  setConflict: (id, conflict, diskContent) =>
    useDocumentsStore.getState().setConflict(id, conflict, diskContent),

  markSaved: (id, path, savedRevision) => {
    useDocumentsStore.getState().markSaved(id, path, savedRevision);
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

/**
 * Snapshot BOTH visible and soft-closed (hidden) documents (Phase B2), for the
 * "is this file already open" dedup at the open sites. A file that was
 * soft-closed is still "open" from the user's perspective — reopening it should
 * re-activate the hidden doc rather than open a duplicate tab. Visible tabs
 * come first (in display order), then hidden docs (LRU order). Reads both
 * stores once (no subscription). Callers that find a hit in `hidden` should
 * call [`useTabsStore.getState().reactivate`](Self.reactivate) instead of
 * `activate`; use [`readOrderedDocuments`] when you want visible-only.
 */
export function readAllDocuments(): {
  id: string;
  path: string | null;
  content: string;
  dirty: boolean;
  revision: number;
  kind: DocumentKind;
  hidden: boolean;
}[] {
  const { tabs, hidden } = useTabsStore.getState();
  const docs = useDocumentsStore.getState().documents;
  const map = (id: string, isHidden: boolean) => {
    const d = docs[id];
    if (!d) return null;
    return {
      id: d.id,
      path: d.path,
      content: d.content,
      dirty: d.dirty,
      revision: d.revision,
      kind: d.kind ?? "typst",
      hidden: isHidden,
    };
  };
  return [
    ...tabs.map((id) => map(id, false)),
    ...hidden.map((id) => map(id, true)),
  ].filter((x): x is NonNullable<typeof x> => x !== null);
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
