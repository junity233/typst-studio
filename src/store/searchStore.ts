import { create } from "zustand";
import type { SearchHit, SearchQuery } from "../lib/types";
import { searchWorkspace } from "../lib/tauri";
import { readSetting } from "../hooks/useSetting";

/**
 * Search view state (§Search view). Holds the query box text + option toggles
 * and the latest result set. The sidebar body debounces `run()` on query/option
 * changes (300ms) so typing doesn't flood the backend. Visibility is owned by
 * `uiStore.activeViewId` (Search is now a regular sidebar view), not here.
 */
export interface SearchState {
  /** The query box text (not yet committed — `run` reads it live). */
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  results: SearchHit[];
  searching: boolean;
  error: string | null;

  setQuery: (q: string) => void;
  setOption: (key: "isRegex" | "caseSensitive" | "wholeWord", v: boolean) => void;
  run: () => Promise<void>;
  /** Discard in-flight/results without changing the query or options. */
  invalidateResults: () => void;
  clear: () => void;
}

// Monotonic sequence counter for run() request ordering. A late-arriving older
// response (seq !== runSeq) is discarded so it can't overwrite newer results.
let runSeq = 0;

export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  results: [],
  searching: false,
  error: null,

  setQuery: (q) => set({ query: q }),
  setOption: (key, v) => set({ [key]: v } as Pick<SearchState, typeof key>),

  run: async () => {
    const { query, isRegex, caseSensitive, wholeWord } = get();
    if (!query.trim()) {
      set({ results: [], error: null });
      return;
    }
    const seq = ++runSeq;
    set({ searching: true, error: null });
    try {
      const req: SearchQuery = {
        pattern: query,
        isRegex,
        caseSensitive,
        wholeWord,
        includeGlob: null,
        maxPerFile: readSetting<number>("search.maxPerFile", 200),
        maxTotal: readSetting<number>("search.maxTotal", 2000),
      };
      const hits = await searchWorkspace(req);
      if (seq !== runSeq) return; // a newer run superseded this one — discard
      set({ results: hits, searching: false });
    } catch (e) {
      if (seq !== runSeq) return;
      set({
        results: [],
        searching: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  invalidateResults: () => {
    ++runSeq;
    set({ results: [], error: null, searching: false });
  },

  clear: () => {
    // Bumping runSeq discards any in-flight run(); resetting `searching` too,
    // because that run's completion is now guarded out and would otherwise
    // leave the "Searching…" indicator stuck on.
    ++runSeq;
    set({ query: "", results: [], error: null, searching: false });
  },
}));
