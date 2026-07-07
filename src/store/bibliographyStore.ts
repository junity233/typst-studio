import { create } from "zustand";
import type { BibEntry, BibEntryEditable, BibFileInfo } from "../lib/types";
import {
  bibliographyDiscover as bibliographyDiscoverBE,
  bibliographyParse as bibliographyParseBE,
  bibliographyParseFull as bibliographyParseFullBE,
  bibliographySaveEntries as bibliographySaveEntriesBE,
} from "../lib/tauri";
import { toIpcError } from "../lib/ipc-error";

/**
 * Monotonic generation counter guarding `discoverFiles` against the
 * workspace-switch race (I1). Each call increments it and captures the value;
 * an in-flight discovery whose captured generation is no longer the latest
 * discards its result so a slow `discoverFiles(A)` can't clobber a fresher
 * `discoverFiles(B)`'s file list.
 */
let discoverGen = 0;

/**
 * Bibliography panel store (Task 4). Holds the discovered bib files in the
 * workspace, the entries of the currently-selected file, the search query, and
 * loading/error state. Mirrors the shape of `packagesStore`.
 *
 * The panel drives discovery on mount / when the workspace root changes, and
 * loads entries when the user picks a file. Entry insertion (`#cite(<key>)`) is
 * handled in the panel via `editorApiRef` (module-level ref, no store coupling).
 *
 * CRUD (add/update/delete) operates on `fullEntries` (the full-field editable
 * form) and persists via `saveEntries`, which round-trips through the backend's
 * serialize-and-write command. The 5-field `entries` list (panel display) is
 * refreshed from the same parse so the list and the file always agree.
 */
export interface BibliographyState {
  /** Files discovered under the workspace root (`.bib`/`.yml`/`.yaml`). */
  discoveredFiles: BibFileInfo[];
  /** Absolute path of the file whose entries are loaded, or null. */
  activeFilePath: string | null;
  /** Parsed entries for `activeFilePath` (5-field list projection). */
  entries: BibEntry[];
  /** Full-field editable entries for `activeFilePath` (edit-modal form). */
  fullEntries: BibEntryEditable[];
  /** Current search query (filters entries by key/title/authors). */
  query: string;
  /** True while a discover, parse, or save is in flight (for spinners). */
  loading: boolean;
  /** Last error message, or null. Shown as a status line in the panel. */
  error: string | null;
  /** Paths that failed to parse — auto-select skips these so a single broken
   *  file can't loop (load → error → activeFilePath=null → auto-select → load …). */
  failedPaths: string[];

  /** Walk the workspace root for bibliography files. No-op-ish when closed. */
  discoverFiles: (rootPath: string | null) => Promise<void>;
  /** Parse a selected file into entries (sets `activeFilePath` + `entries` +
   *  `fullEntries`). */
  loadFile: (path: string) => Promise<void>;
  /** Update the search query (debounced by the panel before being pushed). */
  setQuery: (q: string) => void;
  /** Persist the full edited entry list, then re-load both projections. */
  saveEntries: (entries: BibEntryEditable[]) => Promise<void>;
  /** Append `entry` to `fullEntries` and save. */
  addEntry: (entry: BibEntryEditable) => Promise<void>;
  /** Replace the entry with key `originalKey` (handling a key change) and save. */
  updateEntry: (originalKey: string, entry: BibEntryEditable) => Promise<void>;
  /** Remove the entry with `key` and save. */
  deleteEntry: (key: string) => Promise<void>;
  /** Reset everything (e.g. on workspace close). */
  clear: () => void;
}

export const useBibliographyStore = create<BibliographyState>((set, get) => ({
  discoveredFiles: [],
  activeFilePath: null,
  entries: [],
  fullEntries: [],
  query: "",
  loading: false,
  error: null,
  failedPaths: [],

  discoverFiles: async (rootPath) => {
    // A new discovery invalidates the previous selection: the old active file
    // belongs to the (now-replaced) workspace, so reset it + its entries so the
    // panel auto-selects a fresh file from the new list. Failed-path memory is
    // also cleared — a re-discovery (e.g. after the user fixes the file on
    // disk) deserves a clean retry.
    const gen = ++discoverGen;
    set({
      loading: true,
      error: null,
      activeFilePath: null,
      entries: [],
      fullEntries: [],
      failedPaths: [],
    });
    try {
      const files = await bibliographyDiscoverBE(rootPath);
      // Staleness guard (I1): a newer discovery (workspace switch) supersedes
      // this one — drop the result so it can't overwrite the fresher list.
      if (gen !== discoverGen) return;
      set({ discoveredFiles: files, loading: false });
    } catch (e) {
      if (gen !== discoverGen) return;
      set({ loading: false, error: toIpcError(e).message });
    }
  },

  loadFile: async (path) => {
    set({
      loading: true,
      error: null,
      activeFilePath: path,
      entries: [],
      fullEntries: [],
    });
    try {
      // Parse both projections from the same file in parallel — they share the
      // backend's disk read logic but produce different shapes (5-field list
      // vs full editable). Parallel keeps the round-trip to a single RTT-ish.
      const [entries, fullEntries] = await Promise.all([
        bibliographyParseBE(path),
        bibliographyParseFullBE(path),
      ]);
      set({ entries, fullEntries, loading: false });
    } catch (e) {
      // Record the failure so the panel's auto-select skips this path on the
      // next pick (otherwise: load → error → activeFilePath=null → auto-select
      // → load the SAME broken file → infinite loop). Clear activeFilePath so
      // the <select> doesn't keep showing the broken file as selected.
      set((s) => ({
        loading: false,
        activeFilePath: null,
        error: toIpcError(e).message,
        failedPaths: s.failedPaths.includes(path)
          ? s.failedPaths
          : [...s.failedPaths, path],
      }));
    }
  },

  setQuery: (q) => set({ query: q }),

  saveEntries: async (entries) => {
    const path = get().activeFilePath;
    if (path === null) return;
    set({ loading: true, error: null });
    try {
      await bibliographySaveEntriesBE(path, entries);
      // Re-load both projections from disk so the list and the file agree
      // (the backend's re-parse-and-patch may normalize field order/names).
      const [listEntries, fullEntries] = await Promise.all([
        bibliographyParseBE(path),
        bibliographyParseFullBE(path),
      ]);
      set({ entries: listEntries, fullEntries, loading: false });
    } catch (e) {
      // On error leave fullEntries/entries unchanged so a failed save doesn't
      // corrupt the in-memory list — the user can retry or discard.
      set({ loading: false, error: toIpcError(e).message });
    }
  },

  addEntry: async (entry) => {
    const fullEntries = get().fullEntries;
    // Avoid duplicate keys: if the key already exists, the backend insert would
    // silently overwrite. The modal pre-checks this, but guard anyway.
    const next = fullEntries.some((e) => e.key === entry.key)
      ? fullEntries.map((e) => (e.key === entry.key ? entry : e))
      : [...fullEntries, entry];
    await get().saveEntries(next);
  },

  updateEntry: async (originalKey, entry) => {
    const fullEntries = get().fullEntries;
    // Replace the old-keyed entry in place (preserving list order) — this
    // covers both the unchanged-key case and the key-change case (the old key
    // is swapped out for the new one at the same index). If the new key
    // collides with a DIFFERENT existing entry, the backend dedupes by key
    // (last-wins), so the colliding entry is effectively replaced. The modal
    // does NOT pre-check for collisions today — a future enhancement.
    const next = fullEntries.map((e) =>
      e.key === originalKey ? entry : e,
    );
    await get().saveEntries(next);
  },

  deleteEntry: async (key) => {
    const fullEntries = get().fullEntries;
    const next = fullEntries.filter((e) => e.key !== key);
    await get().saveEntries(next);
  },

  clear: () =>
    set({
      discoveredFiles: [],
      activeFilePath: null,
      entries: [],
      fullEntries: [],
      query: "",
      loading: false,
      error: null,
      failedPaths: [],
    }),
}));
