import { create } from "zustand";

/**
 * Global open/close state for the Insert Formula modal.
 *
 * The modal has TWO entry points — the format-toolbar "Insert formula" button
 * and the `insert-formula` command (Ctrl+Alt+M, command palette) — and both
 * need to open the SAME modal. Rather than threading callbacks through props
 * (the toolbar) and a command handler (no React context), we lift the open flag
 * into a module-scoped Zustand store, exactly like {@link
 * "D:/code/typst-studio/src/store/dialogStore"}. The `FormulaModal` component
 * (mounted once at the app root) subscribes to `isOpen` and renders itself when
 * true; everyone else just calls `open()`.
 *
 * `initialLatex` lets a caller pre-fill the field — the toolbar passes the
 * current selection so the user can convert an existing LaTeX-ish fragment in
 * place. It is read once on open (the modal seeds its local input state from
 * it), so a later `open()` with a new value replaces a stale one cleanly.
 *
 * Naming note: the visibility flag is `isOpen` (not `open`) so it doesn't
 * collide with the `open()` action in the same state object — Zustand merges
 * them into one record, and a shared key would have one clobber the other.
 */
export interface FormulaModalState {
  /** Whether the modal is currently shown. */
  isOpen: boolean;
  /** Seed value for the LaTeX input (typically the current editor selection). */
  initialLatex: string;
  /** Show the modal, optionally pre-filling the LaTeX input. */
  open: (initialLatex?: string) => void;
  /** Hide the modal (Cancel / Esc / overlay click / after a successful insert). */
  close: () => void;
}

export const useFormulaModalStore = create<FormulaModalState>()((set) => ({
  isOpen: false,
  initialLatex: "",
  open: (initialLatex = "") => set({ isOpen: true, initialLatex }),
  close: () => set({ isOpen: false, initialLatex: "" }),
}));
