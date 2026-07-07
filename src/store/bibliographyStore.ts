import { create } from "zustand";
import type { BibEntry, BibFileInfo } from "../lib/types";
import {
  bibliographyDiscover as bibliographyDiscoverBE,
  bibliographyParse as bibliographyParseBE,
} from "../lib/tauri";
import { toIpcError } from "../lib/ipc-error";

/**
 * Bibliography panel store (Task 4). Holds the discovered bib files in the
 * workspace, the entries of the currently-selected file, the search query, and
 * loading/error state. Mirrors the shape of `packagesStore`.
 *
 * The panel drives discovery on mount / when the workspace root changes, and
 * loads entries when the user picks a file. Entry insertion (`#cite(<key>)`) is
 * handled in the panel via `editorApiRef` (module-level ref, no store coupling).
 */
export interface BibliographyState {
  /** Files discovered under the workspace root (`.bib`/`.yml`/`.yaml`). */
  discoveredFiles: BibFileInfo[];
  /** Absolute path of the file whose entries are loaded, or null. */
  activeFilePath: string | null;
  /** Parsed entries for `activeFilePath`. */
  entries: BibEntry[];
  /** Current search query (filters entries by key/title/authors). */
  query: string;
  /** True while a discover or parse is in flight (for spinners). */
  loading: boolean;
  /** Last error message, or null. Shown as a status line in the panel. */
  error: string | null;

  /** Walk the workspace root for bibliography files. No-op-ish when closed. */
  discoverFiles: (rootPath: string | null) => Promise<void>;
  /** Parse a selected file into entries (sets `activeFilePath` + `entries`). */
  loadFile: (path: string) => Promise<void>;
  /** Update the search query (debounced by the panel before being pushed). */
  setQuery: (q: string) => void;
  /** Reset everything (e.g. on workspace close). */
  clear: () => void;
}

export const useBibliographyStore = create<BibliographyState>((set) => ({
  discoveredFiles: [],
  activeFilePath: null,
  entries: [],
  query: "",
  loading: false,
  error: null,

  discoverFiles: async (rootPath) => {
    // A new discovery invalidates the previous selection: the old active file
    // belongs to the (now-replaced) workspace, so reset it + its entries so the
    // panel auto-selects a fresh file from the new list.
    set({ loading: true, error: null, activeFilePath: null, entries: [] });
    try {
      const files = await bibliographyDiscoverBE(rootPath);
      set({ discoveredFiles: files, loading: false });
    } catch (e) {
      set({ loading: false, error: toIpcError(e).message });
    }
  },

  loadFile: async (path) => {
    set({ loading: true, error: null, activeFilePath: path, entries: [] });
    try {
      const entries = await bibliographyParseBE(path);
      set({ entries, loading: false });
    } catch (e) {
      set({ loading: false, error: toIpcError(e).message });
    }
  },

  setQuery: (q) => set({ query: q }),

  clear: () =>
    set({
      discoveredFiles: [],
      activeFilePath: null,
      entries: [],
      query: "",
      loading: false,
      error: null,
    }),
}));
