import { create } from "zustand";

/**
 * Ephemeral UI state: pane visibility toggles driven by the View menu
 * (Toggle Sidebar / Toggle Preview). Kept separate from workspace/tab state so
 * view preferences survive tab/workspace changes.
 */
export interface UiState {
  sidebarVisible: boolean;
  previewVisible: boolean;
  toggleSidebar: () => void;
  togglePreview: () => void;
  setSidebar: (v: boolean) => void;
  setPreview: (v: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarVisible: true,
  previewVisible: true,
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  togglePreview: () => set((s) => ({ previewVisible: !s.previewVisible })),
  setSidebar: (v) => set({ sidebarVisible: v }),
  setPreview: (v) => set({ previewVisible: v }),
}));
