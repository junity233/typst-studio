import { create } from "zustand";

/**
 * Live editor statistics for the StatusBar: caret position, selection size,
 * and whole-document counts. Written by EditorArea (from the Monaco API's
 * cursor/selection events + the doc's content) and read by the StatusBar.
 *
 * The store is deliberately dumb — all computation (word/char counting)
 * happens in the producer, so this module stays trivially testable and the
 * StatusBar's selectors stay cheap (plain field reads).
 */
export interface EditorStats {
  /** The doc the stats describe; `null` when no text tab is active. */
  docId: string | null;
  /** Caret line, 1-based (Monaco convention). 0 when unknown. */
  line: number;
  /** Caret column, 1-based. 0 when unknown. */
  column: number;
  /** Selected characters (code points); 0 for a collapsed caret. */
  selectionChars: number;
  /** Selected words (CJK-aware count); 0 for a collapsed caret. */
  selectionWords: number;
  /** Whole-document character count (code points). */
  docChars: number;
  /** Whole-document word count (CJK-aware). */
  docWords: number;
}

interface EditorStatsState extends EditorStats {
  /** Merge new values (undefined fields keep their current value). */
  update: (partial: Partial<EditorStats>) => void;
  /** Reset to the no-document state. */
  clear: () => void;
}

const EMPTY: EditorStats = {
  docId: null,
  line: 0,
  column: 0,
  selectionChars: 0,
  selectionWords: 0,
  docChars: 0,
  docWords: 0,
};

export const useEditorStatsStore = create<EditorStatsState>()((set) => ({
  ...EMPTY,
  update: (partial) => set(partial),
  clear: () => set(EMPTY),
}));
