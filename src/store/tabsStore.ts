import { create } from "zustand";
import type { CompileStatus } from "../lib/ui-types";
import type { OpenedDocument } from "../lib/types";
import {
  closeTab as closeTabBE,
  newTab as newTabBE,
} from "../lib/tauri";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { recordFile } from "../lib/session";

/**
 * A single open document. `svgPages` holds the rendered preview pages emitted
 * by the backend; it lives on the Tab (rather than a separate previewStore)
 * so the PreviewPane can read a single selector and tab switches are atomic.
 */
export interface Tab {
  id: string;
  title: string;
  path: string | null;
  dirty: boolean;
  content: string;
  status: CompileStatus;
  durationMs: number | null;
  svgPages: string[];
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
  updateContent: (id: string, content: string) => void;
  setStatus: (id: string, status: CompileStatus, durationMs?: number) => void;
  /** Replace the rendered preview pages for a tab. */
  setPages: (id: string, svgPages: string[]) => void;
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
    status: "idle",
    durationMs: null,
    svgPages: [],
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
        return { ...tab, content, dirty: true };
      }),
    })),

  setStatus: (id, status, durationMs) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.id === id
          ? { ...tab, status, durationMs: durationMs ?? tab.durationMs }
          : tab,
      ),
    })),

  setPages: (id, svgPages) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.id === id ? { ...tab, svgPages } : tab,
      ),
    })),

  markSaved: (id, path) =>
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
    })),
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
