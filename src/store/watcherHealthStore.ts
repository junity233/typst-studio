import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Watcher-health state (§6.3 "watcher 创建失败时...状态栏明确提示外部修改检测
 * 不可用").
 *
 * The backend's filesystem watcher can fail to start (notify/FSEvents edge
 * cases) or silently stop delivering events. When it fails to start, the
 * `get_watcher_health` IPC reports `watcher_failed: true` and the StatusBar
 * surfaces a non-modal warning. The polling fallback runs regardless (server-
 * side), so this flag is purely a UI affordance — external changes are still
 * detected, just less promptly.
 *
 * The flag is polled once on first read (no push event). It only changes on
 * workspace open/close, so a read-per-open is sufficient; the StatusBar
 * refreshes it whenever the workspace changes.
 */
export interface WatcherHealthState {
  /** True when the workspace watcher failed to start. */
  watcherFailed: boolean;
  /** Refresh from the backend (call on workspace open/close). */
  refresh: () => Promise<void>;
}

export const useWatcherHealthStore = create<WatcherHealthState>((set) => ({
  watcherFailed: false,
  refresh: async () => {
    try {
      const payload = await invoke<{ watcherFailed: boolean }>(
        "get_watcher_health",
      );
      set({ watcherFailed: payload.watcherFailed });
    } catch {
      // IPC unavailable (e.g. early in startup) — leave the default.
    }
  },
}));
