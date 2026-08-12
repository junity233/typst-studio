import { create } from "zustand";

/**
 * Global open/close state for the About dialog.
 *
 * The About dialog is driven by a module-scoped Zustand store so that several
 * entry points — the Help → About menu item, the `open-about` command (command
 * palette) — can all open the SAME dialog without threading callbacks around.
 * The `AboutModal` component (mounted once at the app root) subscribes to
 * `isOpen` and renders itself when true; everyone else just calls `open()`.
 *
 * Mirrors {@link "D:/code/typst-studio/src/store/formulaModalStore"}. The
 * visibility flag is `isOpen` (not `open`) to avoid colliding with the `open()`
 * action in the same merged state record.
 */
export interface AboutModalState {
  /** Whether the About dialog is currently shown. */
  isOpen: boolean;
  /** Show the About dialog. */
  open: () => void;
  /** Hide the dialog (Close button / Esc / overlay click). */
  close: () => void;
}

export const useAboutModalStore = create<AboutModalState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
