import { create } from "zustand";
import type { SearchHit, SearchQuery } from "../lib/types";
import { searchWorkspace } from "../lib/tauri";

/**
 * Search view state (§Search view). Holds the query box text + option toggles,
 * the latest result set, and the bottom-panel visibility. The panel debounces
 * `run()` on query/option changes (300ms) so typing doesn't flood the backend.
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
  visible: boolean;

  setQuery: (q: string) => void;
  setOption: (key: "isRegex" | "caseSensitive" | "wholeWord", v: boolean) => void;
  run: () => Promise<void>;
  clear: () => void;
  toggle: () => void;
  show: () => void;
  hide: () => void;
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
  visible: false,

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
        maxPerFile: 200,
        maxTotal: 2000,
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

  clear: () => {
    ++runSeq;
    set({ query: "", results: [], error: null });
  },
  toggle: () => set((s) => ({ visible: !s.visible })),
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
}));
