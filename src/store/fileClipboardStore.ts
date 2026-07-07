import { create } from "zustand";
import type { EntryKind } from "../lib/types";

/**
 * In-memory clipboard for file Copy / Cut / Paste inside the Explorer.
 *
 * No real OS clipboard is involved — this only holds workspace-relative path
 * references for the file manager's own paste action (the paste target is
 * always a directory in the open workspace). Cut is **lazy**: storing a cut
 * entry does NOT touch the disk; the move happens on Paste (via
 * `renameEntry`). A cut entry is visually de-emphasized (`.tree-row-cut`)
 * until pasted or cleared.
 *
 * The `entries` array is kept (rather than a single value) so multi-select can
 * be layered in later without a schema change; the UI currently only sets one
 * entry at a time.
 */
export interface ClipboardEntry {
  /** Workspace-relative path (forward slashes; "" = root, never copied). */
  relative: string;
  /** Last path component (for display + name-collision resolution on paste). */
  name: string;
  kind: EntryKind;
}

export type ClipboardMode = "copy" | "cut";

export interface FileClipboardState {
  entries: ClipboardEntry[];
  mode: ClipboardMode;
  /** Copy `rel` into the clipboard (a later Paste duplicates it). */
  setCopy: (relative: string, name: string, kind: EntryKind) => void;
  /** Cut `rel` into the clipboard (a later Paste moves it). */
  setCut: (relative: string, name: string, kind: EntryKind) => void;
  /** Clear the clipboard (after a move-Paste, or on demand). */
  clear: () => void;
}

export const useFileClipboardStore = create<FileClipboardState>()((set) => ({
  entries: [],
  mode: "copy",
  setCopy: (relative, name, kind) =>
    set({ entries: [{ relative, name, kind }], mode: "copy" }),
  setCut: (relative, name, kind) =>
    set({ entries: [{ relative, name, kind }], mode: "cut" }),
  clear: () => set({ entries: [], mode: "copy" }),
}));

/**
 * Read the current clipboard snapshot without subscribing (for one-off reads in
 * event handlers that don't want to re-render on clipboard change).
 */
export function readClipboard(): { entries: ClipboardEntry[]; mode: ClipboardMode } {
  const s = useFileClipboardStore.getState();
  return { entries: s.entries, mode: s.mode };
}
