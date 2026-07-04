import { create } from "zustand";

/**
 * Ephemeral UI state: pane visibility toggles driven by the View menu
 * (Toggle Sidebar / Toggle Preview). Kept separate from workspace/tab state so
 * view preferences survive tab/workspace changes.
 */
export interface UiState {
  sidebarVisible: boolean;
  previewVisible: boolean;
  /** Currently active sidebar view id (null = no active view). */
  activeViewId: string | null;
  toggleSidebar: () => void;
  togglePreview: () => void;
  setSidebar: (v: boolean) => void;
  setPreview: (v: boolean) => void;
  /** Directly set active view; also shows the sidebar (or hides if null). */
  setActiveView: (id: string | null) => void;
  /** VSCode semantics: if same view is active and sidebar is visible, hide it;
   *  otherwise switch to the view and show the sidebar. */
  toggleView: (id: string) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarVisible: true,
  previewVisible: true,
  activeViewId: "workbench.explorer",

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  togglePreview: () => set((s) => ({ previewVisible: !s.previewVisible })),
  setSidebar: (v) => set({ sidebarVisible: v }),
  setPreview: (v) => set({ previewVisible: v }),

  setActiveView: (id) => set({ activeViewId: id, sidebarVisible: id !== null }),
  toggleView: (id) =>
    set((s) => {
      if (s.activeViewId === id && s.sidebarVisible) {
        return { sidebarVisible: false };
      }
      return { activeViewId: id, sidebarVisible: true };
    }),
}));
