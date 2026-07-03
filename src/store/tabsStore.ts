import { create } from "zustand";
import type { CompileStatus } from "../lib/ui-types";
import type { LineRect, OpenedDocument } from "../lib/types";
import {
  closeTab as closeTabBE,
  newTab as newTabBE,
} from "../lib/tauri";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { recordFile } from "../lib/session";

/**
 * A single open document. `svgPages` holds the rendered preview pages emitted
 * by the backend; `lineMap` is the matching source-line → page-rect index used
 * for scroll-sync and click-to-source. Both live on the Tab (rather than a
 * separate previewStore) so the PreviewPane can read a single selector and tab
 * switches are atomic.
 *
 * `revision` (§7) is the authoritative content version. It is bumped
 * optimistically on every `updateContent` and carried by every compile/status
 * event from the backend; an event whose `revision` is strictly older than the
 * tab's current `revision` is discarded, so a slow compile can never overwrite
 * a newer preview.
 */
export interface Tab {
  id: string;
  title: string;
  path: string | null;
  dirty: boolean;
  content: string;
  /** Monotonic content revision; bumped on every edit (§7). */
  revision: number;
  status: CompileStatus;
  durationMs: number | null;
  svgPages: string[];
  /** Source line → preview-page bbox, from the last `compiled` event. */
  lineMap: LineRect[];
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** Create an untitled tab via the backend; returns the new tab id. */
  openTab: (content?: string) => Promise<string>;
  /** Add an already-opened (file-backed) document to the store. */
  openPath: (doc: OpenedDocument) => void;
  /** Close on the backend, then drop the local tab. */
  closeTab: (id: string) => Promise<void>;
  activate: (id: string) => void;
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
  markSaved: (id: string, path: string) => void;
}

export const DEFAULT_CONTENT =
  "#set page(width: 21cm, height: 29.7cm)\n\nHello, Typst!\n";

function tabFromOpened(doc: OpenedDocument): Tab {
  return {
    id: doc.id,
    title: doc.title,
    path: doc.path,
    dirty: doc.dirty,
    content: doc.content,
    // The backend seeds revision 0 on open; the first compile carries revision
    // 0 and matches this. Each subsequent edit bumps it.
    revision: 0,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
  };
}

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: async (content) => {
    // Backend auto-compiles on new_tab, so the initial preview arrives via
    // the `compiled` event — no need for a separate updateText round-trip.
    const doc = await newTabBE(content);
    const tab = tabFromOpened(doc);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: doc.id }));
    return doc.id;
  },

  openPath: (doc) => {
    const tab = tabFromOpened(doc);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: doc.id }));
    // Remember the opened file so it can be restored on next launch.
    if (doc.path) recordFile(doc.path);
  },

  closeTab: async (id) => {
    try {
      await closeTabBE(id);
    } catch (e) {
      // Backend may reject (already gone); still drop the local tab.
      console.warn("[closeTab] backend rejected:", e);
    }
    useDiagnosticsStore.getState().clear(id);
    set((s) => {
      const tabs = s.tabs.filter((tab) => tab.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      }
      return { tabs, activeId };
    });
  },

  activate: (id) => {
    if (get().tabs.some((tab) => tab.id === id)) {
      set({ activeId: id });
    }
  },

  updateContent: (id, content) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== id || content === tab.content) return tab;
        // Bump the optimistic revision. The backend's next compile event will
        // carry this same revision (or higher); older events are then ignored.
        return { ...tab, content, dirty: true, revision: tab.revision + 1 };
      }),
    })),

  setStatus: (id, revision, status, durationMs) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        // §7: discard stale-revision status. A strictly-older revision means a
        // newer edit already superseded this compile — never overwrite the UI.
        if (revision < tab.revision) return tab;
        return { ...tab, status, durationMs: durationMs ?? tab.durationMs };
      }),
    })),

  setPages: (id, revision, svgPages, lineMap) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        // §7: discard stale-revision preview. Without this guard, a slow
        // compile of an older buffer could clobber a newer preview.
        if (revision < tab.revision) return tab;
        return { ...tab, svgPages, lineMap };
      }),
    })),

  markSaved: (id, path) => {
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              path,
              title: path.split(/[\\/]/).pop() ?? tab.title,
              dirty: false,
            }
          : tab,
      ),
    }));
    // Refresh the session's last-file hint on every save (covers Save, Save
    // As, and the close-guard Save-All), so relaunch reopens the latest file.
    recordFile(path);
  },
}));

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
