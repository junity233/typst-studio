import { create } from "zustand";

/**
 * The currently-selected row in the Explorer tree, tracked by workspace-relative
 * path. This is distinct from the "active open document" highlight (which marks
 * the file whose tab is focused) — selection is the keyboard-navigation / right-
 * click anchor that drives F2 / Delete / Ctrl+C / Ctrl+X / Ctrl+V shortcuts.
 *
 * A row becomes selected on single click or right-click; the keyboard handlers
 * on the tree container operate on the selected path. `null` means nothing is
 * selected (no row shortcuts fire).
 */
export interface ExplorerSelectionState {
  selectedRel: string | null;
  set: (rel: string | null) => void;
}

export const useExplorerSelectionStore = create<ExplorerSelectionState>()((set) => ({
  selectedRel: null,
  set: (rel) => set({ selectedRel: rel }),
}));
