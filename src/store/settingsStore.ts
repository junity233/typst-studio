import { create } from "zustand";
import {
  getAllSettings,
  getSettingsManifest,
  onSettingsChanged,
  setSetting,
} from "../lib/tauri";
import type { Manifest } from "../lib/settings-types";

/**
 * Settings store: holds the whole runtime config object plus the manifest, and
 * keeps `data` in sync across windows via the backend-broadcast
 * `settings_changed` event.
 *
 * Mutation flow (live-apply, NO optimistic update): a component calls
 * `set(path, value)` → `set_setting` IPC → backend validates + persists +
 * emits `settings_changed` to ALL windows → this store's listener replaces
 * `data` → every `useSetting` subscriber re-renders. The round-trip (rather
 * than a local update on `set`) guarantees the main and settings windows
 * converge to the same truth even when backend validation rejects a value.
 */
export interface SettingsState {
  /** The full runtime config object (dot-paths are walked at read time). */
  data: Record<string, unknown>;
  /** The UI descriptor, fetched once per window on hydrate. */
  manifest: Manifest | null;
  /** Load manifest + data and subscribe to changes. Idempotent per window. */
  hydrate: () => Promise<void>;
  /** Fire a `set_setting` IPC. Does NOT touch `data` locally — the
   *  `settings_changed` event round-trip is the single source of truth. */
  set: (path: string, value: unknown) => Promise<void>;
}

/** True once `hydrate` has subscribed this window to `settings_changed`. */
let subscribed = false;

export const useSettingsStore = create<SettingsState>()((set) => ({
  data: {},
  manifest: null,

  hydrate: async () => {
    // Load manifest + current data together; degrade gracefully so a transient
    // IPC failure can't permanently brick the window.
    const [manifest, data] = await Promise.all([
      getSettingsManifest().catch((e) => {
        console.warn("[settings.hydrate] manifest fetch failed:", e);
        return null;
      }),
      getAllSettings().catch((e) => {
        console.warn("[settings.hydrate] data fetch failed:", e);
        return {} as Record<string, unknown>;
      }),
    ]);
    set({ manifest, data });

    // Subscribe exactly once per window — hydrate may be called from both a
    // root effect and a nested component on mount.
    if (!subscribed) {
      subscribed = true;
      onSettingsChanged((next) => {
        set({ data: next });
      }).catch((e) => {
        console.warn("[settings.hydrate] subscribe failed:", e);
        subscribed = false; // allow a later hydrate to retry
      });
    }
  },

  set: async (path, value) => {
    await setSetting(path, value);
    // No local update: the settings_changed event (broadcast to all windows by
    // the backend) repopulates `data`.
  },
}));
