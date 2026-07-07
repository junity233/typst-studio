import { create } from "zustand";

/**
 * Command Palette visibility + query state. Mirrors the open/close action
 * pattern of `contextMenuStore`. The `CommandPalette` component reads `open`
 * to decide whether to render, and `query` is the live text in its input.
 *
 * Closing always resets the query so the next open starts from a blank filter
 * (VS Code behavior).
 */
export interface CommandPaletteState {
  /** Whether the palette overlay is currently shown. */
  open: boolean;
  /** The current filter text (controlled input value). */
  query: string;
  /** Open the palette (leaves the query as-is only if already open). */
  openPalette: () => void;
  /** Close the palette and reset the query to empty. */
  closePalette: () => void;
  /** Update the filter text. */
  setQuery: (q: string) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()((set) => ({
  open: false,
  query: "",
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false, query: "" }),
  setQuery: (q) => set({ query: q }),
}));
