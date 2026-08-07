import { create } from "zustand";
import type {
  OpenDocReplacement,
  ReplaceFailure,
  SearchHit,
  SearchQuery,
  ReplaceRequest,
  TargetRef,
} from "../lib/types";
import { replaceInFiles, searchWorkspace } from "../lib/tauri";
import { readSetting } from "../hooks/useSetting";
import { useDocumentsStore } from "./documentsStore";

/**
 * Search view state (§Search view). Holds the query box text + option toggles
 * and the latest result set. The sidebar body debounces `run()` on query/option
 * changes (300ms) so typing doesn't flood the backend. Visibility is owned by
 * `uiStore.activeViewId` (Search is now a regular sidebar view), not here.
 *
 * Replace: `replaceAll` / `replaceOne` delegate to the backend
 * `replace_in_files` command. Open documents are updated in-memory (buffer +
 * revision) by the backend, which returns the new content + revision; the
 * frontend mirrors each into Monaco via a "controlled replace" handshake (see
 * `applyReplaceOutcome`) so the editor visibly reflects the change WITHOUT
 * desyncing the revision (a plain `updateText` from here would be silently
 * dropped by the backend's staleness guard on the user's next keystroke).
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

  /** The replace box text. Empty = delete matches on replace. */
  replaceValue: string;
  /** When true, literal replacements mirror the matched text's casing. */
  preserveCase: boolean;
  /** True while a replace-all / per-hit replace is in flight. */
  replacing: boolean;
  /**
   * Closed files that could not be written during the last replace (permission
   * denied, disk full, vanished mid-batch, …). The backend is best-effort
   * across the workspace — a failure on one file doesn't roll back the others —
   * so we surface this list so the user knows not every match was applied.
   * Cleared at the start of each replace; empty after a fully-successful run.
   */
  replaceFailures: ReplaceFailure[];

  setQuery: (q: string) => void;
  setOption: (key: "isRegex" | "caseSensitive" | "wholeWord", v: boolean) => void;
  run: () => Promise<void>;
  /** Discard in-flight/results without changing the query or options. */
  invalidateResults: () => void;
  clear: () => void;

  setReplaceValue: (v: string) => void;
  setPreserveCase: (v: boolean) => void;
  /** Replace every match in the workspace with `replaceValue`. */
  replaceAll: () => Promise<void>;
  /** Replace a single hit at an exact line/column, leaving other matches. */
  replaceOne: (hit: SearchHit) => Promise<void>;
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

  replaceValue: "",
  preserveCase: false,
  replacing: false,
  replaceFailures: [],

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

  setReplaceValue: (v) => set({ replaceValue: v }),
  setPreserveCase: (v) => set({ preserveCase: v }),

  replaceAll: async () => {
    const { query, isRegex, caseSensitive, wholeWord, preserveCase, replaceValue } = get();
    if (!query.trim()) return;
    const seq = ++runSeq;
    set({ replacing: true, error: null, replaceFailures: [] });
    try {
      const req: ReplaceRequest = {
        query: {
          pattern: query,
          isRegex,
          caseSensitive,
          wholeWord,
          includeGlob: null,
          maxPerFile: readSetting<number>("search.maxPerFile", 200),
          maxTotal: readSetting<number>("search.maxTotal", 2000),
        },
        replacement: replaceValue,
        preserveCase: preserveCase && !isRegex, // regex ignores preserve-case
        target: null,
      };
      const outcome = await replaceInFiles(req);
      // Mirror each open-doc replacement into Monaco + the document store
      // (controlled replace). Closed files were already written to disk.
      await applyReplaceOutcome(outcome.openDocs);
      if (seq !== runSeq) return;
      // Surface any closed-file write failures (best-effort batch: partial
      // successes are kept, failures are listed, not rolled back).
      set({ replaceFailures: outcome.failed });
      // Re-run the search so the result list reflects the replacements.
      await get().run();
    } catch (e) {
      if (seq !== runSeq) return;
      set({
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // `replacing` is a UI "in progress" flag, not a result-guard — clear it
      // unconditionally so a stray run() (which bumps runSeq) can't strand it
      // on. The result staleness guard (`seq !== runSeq`) above handles data.
      set({ replacing: false });
    }
  },

  replaceOne: async (hit: SearchHit) => {
    const { query, isRegex, caseSensitive, wholeWord, preserveCase, replaceValue } = get();
    if (!query.trim()) return;
    const seq = ++runSeq;
    set({ replacing: true, error: null, replaceFailures: [] });
    try {
      const target: TargetRef = {
        relative: hit.relative,
        line: hit.line,
        column: hit.column,
      };
      const req: ReplaceRequest = {
        query: {
          pattern: query,
          isRegex,
          caseSensitive,
          wholeWord,
          includeGlob: null,
          maxPerFile: readSetting<number>("search.maxPerFile", 200),
          maxTotal: readSetting<number>("search.maxTotal", 2000),
        },
        replacement: replaceValue,
        preserveCase: preserveCase && !isRegex,
        target,
      };
      const outcome = await replaceInFiles(req);
      await applyReplaceOutcome(outcome.openDocs);
      if (seq !== runSeq) return;
      set({ replaceFailures: outcome.failed });
      await get().run();
    } catch (e) {
      if (seq !== runSeq) return;
      set({
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      set({ replacing: false });
    }
  },
}));

/**
 * Apply the open-document portion of a replace outcome via a "controlled
 * replace": push the new content + revision into BOTH Monaco's model registry
 * (with its anti-bounce-back suppress mark) and the document store, in lockstep.
 *
 * This mirrors `ConflictDialog.handleUseDisk`. It exists because Monaco's buffer
 * sync is one-way (Monaco → backend): a backend `update_text` does NOT refresh
 * Monaco's display, and calling the frontend's own `updateText` afterward would
 * send a now-stale revision that the backend's staleness guard silently drops —
 * losing the user's next keystroke. The controlled replace is the sanctioned
 * path for backend-initiated content changes (see `monacoModelRegistry`'s class
 * doc on "controlled replace").
 *
 * `dirty` is set to true because a replace is an intentional edit the user
 * should save (unlike conflict-use-disk, which adopts the disk state and clears
 * dirty).
 */
export async function applyReplaceOutcome(openDocs: OpenDocReplacement[]): Promise<void> {
  if (openDocs.length === 0) return;
  const { monacoModelRegistry } = await import("../components/Editor/monacoModelRegistry");
  for (const r of openDocs) {
    monacoModelRegistry.applyExternalContent(r.id, r.newContent, r.newRevision);
    useDocumentsStore.setState((s) => {
      const doc = s.documents[r.id];
      if (!doc) return s;
      return {
        documents: {
          ...s.documents,
          [r.id]: {
            ...doc,
            content: r.newContent,
            dirty: true,
            revision: r.newRevision,
          },
        },
      };
    });
  }
}
