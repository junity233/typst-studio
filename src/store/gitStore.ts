import { create } from "zustand";
import type { CommitLog, GitFileStatus } from "../lib/types";
import {
  gitStatus,
  gitStage,
  gitUnstage,
  gitCommit,
  gitLog,
  onFsChanged,
} from "../lib/tauri";
import { readSetting } from "../hooks/useSetting";

/**
 * Source Control view state (§Source Control). Backed by the gix 0.85 IPC
 * commands. `isRepo` is false when the workspace is not inside a git
 * repository — the panel then shows a friendly empty state instead of erroring.
 */
export interface GitState {
  changes: GitFileStatus[];
  recentLog: CommitLog[];
  loading: boolean;
  error: string | null;
  /** False when the workspace is not a git repository. */
  isRepo: boolean;

  refresh: () => Promise<void>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
}

export const useGitStore = create<GitState>((set, get) => ({
  changes: [],
  recentLog: [],
  loading: false,
  error: null,
  isRepo: true,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      // gitStatus and gitLog are independent spawn_blocking calls — run them
      // concurrently to halve latency on large repos. The recent log is
      // best-effort: a repo with an unborn HEAD (no commits yet) returns an
      // empty list, and any backend error just hides the log.
      const [statusResult, recentLog] = await Promise.all([
        gitStatus(),
        gitLog(readSetting<number>("git.defaultLogLimit", 5)).catch(
          () => [] as CommitLog[],
        ),
      ]);
      if (statusResult === null) {
        // Not a git repository — clear out and show the empty state.
        set({ changes: [], recentLog: [], isRepo: false, loading: false });
        return;
      }
      set({ changes: statusResult, recentLog, isRepo: true, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  stage: async (path) => {
    try {
      await gitStage(path);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  unstage: async (path) => {
    try {
      await gitUnstage(path);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  commit: async (message) => {
    try {
      await gitCommit(message);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

// Auto-refresh on filesystem changes (the user staged/committed externally, or
// switched branches in another tool). Initialized once, idempotently.
let autoRefreshInitialized = false;
export function initGitAutoRefresh(): void {
  if (autoRefreshInitialized) return;
  autoRefreshInitialized = true;
  onFsChanged(() => {
    void useGitStore.getState().refresh();
  });
}
