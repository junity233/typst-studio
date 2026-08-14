import { create } from "zustand";
import {
  clearProjectConfig,
  getProjectConfig,
  getProjectConfigPath,
  listTypFiles,
  onProjectConfigChanged,
  setProjectConfig,
  setMainFile,
} from "../lib/tauri";
import type { ProjectConfig } from "../lib/types";

/**
 * The schema version this frontend writes into every `.typstpro` it creates
 * (both the store's "no config yet" default and the Project panel's form).
 * Single source of truth — never hardcode a version where a config object is
 * assembled.
 */
export const CURRENT_PROJECT_SCHEMA_VERSION = 2;

/**
 * Project config store: the workspace's `.typstpro` (main compile file + title)
 * kept in sync across windows via the backend-broadcast `project_config_changed`
 * event.
 *
 * Mutation flow (live-apply, NO optimistic update — mirrors `settingsStore`):
 * a component calls `update` / `setMainFile` / `clear` → IPC → backend
 * validates + persists + emits `project_config_changed` to ALL windows → this
 * store's listener replaces `config` → every subscriber re-renders. The
 * round-trip guarantees all windows converge to the same truth even when
 * backend validation rejects a value.
 */
export interface ProjectConfigState {
  /** The current `.typstpro` config, or `null` (no workspace / no file). */
  config: ProjectConfig | null;
  /** Absolute path to the workspace's `.typstpro` (for the panel status row). */
  configPath: string | null;
  /** Workspace `.typ` files for the main-file picker. */
  typFiles: string[];
  /** Load config + path + candidate files and subscribe to changes. */
  hydrate: () => Promise<void>;
  /** Re-fetch the workspace `.typ` files (call after tree refresh). */
  refreshTypFiles: () => Promise<void>;
  /** Merge a patch into the current config and persist it. */
  update: (patch: Partial<ProjectConfig>) => Promise<void>;
  /** Set (or clear with null) the main compile file, preserving other fields. */
  setMainFile: (path: string | null) => Promise<void>;
  /** Delete the workspace's `.typstpro`. */
  clear: () => Promise<void>;
}

/** True once this window has subscribed to `project_config_changed`. */
let subscribed = false;

export const useProjectConfigStore = create<ProjectConfigState>()((set, get) => ({
  config: null,
  configPath: null,
  typFiles: [],

  hydrate: async () => {
    const [config, configPath, typFiles] = await Promise.all([
      getProjectConfig().catch((e) => {
        console.warn("[projectConfig.hydrate] config fetch failed:", e);
        return null;
      }),
      getProjectConfigPath().catch((e) => {
        console.warn("[projectConfig.hydrate] path fetch failed:", e);
        return null;
      }),
      listTypFiles().catch((e) => {
        console.warn("[projectConfig.hydrate] typ files fetch failed:", e);
        return [] as string[];
      }),
    ]);
    set({ config, configPath, typFiles });

    if (!subscribed) {
      subscribed = true;
      onProjectConfigChanged((next) => {
        set({ config: next });
      }).catch((e) => {
        console.warn("[projectConfig.hydrate] subscribe failed:", e);
        subscribed = false; // allow a later hydrate to retry
      });
    }
  },

  refreshTypFiles: async () => {
    const typFiles = await listTypFiles().catch((e) => {
      console.warn("[projectConfig.refreshTypFiles] failed:", e);
      return get().typFiles;
    });
    set({ typFiles });
  },

  update: async (patch) => {
    const current = get().config ?? {
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      main: null,
      title: null,
    };
    await setProjectConfig({ ...current, ...patch });
    // No local update — the project_config_changed event repopulates `config`.
  },

  setMainFile: async (path) => {
    await setMainFile(path);
    // No local update — the broadcast is the single source of truth.
  },

  clear: async () => {
    await clearProjectConfig();
    // No local update — the broadcast (null) repopulates `config`.
  },
}));
