import { create } from "zustand";
import type { CatalogFilter, InstalledPackage, PackageEntry } from "../lib/types";
import {
  packageInstall as packageInstallBE,
  packageListCatalog as packageListCatalogBE,
  packageListInstalled as packageListInstalledBE,
  packageRefreshIndex as packageRefreshIndexBE,
  packageUninstall as packageUninstallBE,
} from "../lib/tauri";
import { toIpcError } from "../lib/ipc-error";

export type IndexStatus = "idle" | "loading" | "fresh" | "stale" | "error";

export interface PackagesState {
  catalog: PackageEntry[];
  installed: InstalledPackage[];
  activeTab: "templates" | "packages" | "installed";
  filter: CatalogFilter;
  selectedKey: string | null;
  indexStatus: IndexStatus;
  indexFetchedAt: number | null;
  installing: Record<string, boolean>;
  error: string | null;

  setActiveTab: (tab: PackagesState["activeTab"]) => void;
  setFilter: (patch: Partial<CatalogFilter>) => void;
  setSelected: (key: string | null) => void;

  loadCatalog: () => Promise<void>;
  refreshIndex: () => Promise<void>;
  loadInstalled: () => Promise<void>;
  install: (name: string, version: string) => Promise<boolean>;
  uninstall: (name: string, version: string) => Promise<boolean>;
}

export const usePackagesStore = create<PackagesState>((set, get) => ({
  catalog: [],
  installed: [],
  activeTab: "templates",
  // `categories` is required on CatalogFilter, so seed it explicitly.
  filter: { latestOnly: true, categories: [] },
  selectedKey: null,
  indexStatus: "idle",
  indexFetchedAt: null,
  installing: {},
  error: null,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),
  setSelected: (key) => set({ selectedKey: key }),

  loadCatalog: async () => {
    if (get().catalog.length === 0) set({ indexStatus: "loading" });
    try {
      const payload = await packageListCatalogBE(get().filter);
      set({
        catalog: payload.entries,
        indexFetchedAt: payload.fetchedAt,
        indexStatus: payload.stale ? "stale" : "fresh",
        error: null,
      });
    } catch (e) {
      set({ indexStatus: "error", error: toIpcError(e).message });
    }
  },

  refreshIndex: async () => {
    set({ indexStatus: "loading", error: null });
    try {
      await packageRefreshIndexBE();
      await get().loadCatalog();
    } catch (e) {
      set({ indexStatus: "error", error: toIpcError(e).message });
    }
  },

  loadInstalled: async () => {
    try {
      set({ installed: await packageListInstalledBE() });
    } catch (e) {
      set({ error: toIpcError(e).message });
    }
  },

  install: async (name, version) => {
    const key = `${name}@${version}`;
    set((s) => ({ installing: { ...s.installing, [key]: true } }));
    try {
      await packageInstallBE(name, version);
      await get().loadInstalled();
      return true;
    } catch (e) {
      set({ error: toIpcError(e).message });
      return false;
    } finally {
      set((s) => {
        const next = { ...s.installing };
        delete next[key];
        return { installing: next };
      });
    }
  },

  uninstall: async (name, version) => {
    try {
      await packageUninstallBE(name, version);
      await get().loadInstalled();
      return true;
    } catch (e) {
      set({ error: toIpcError(e).message });
      return false;
    }
  },
}));

/** Convenience selector: only template entries (those with a `[template]` table). */
export function selectTemplates(state: PackagesState): PackageEntry[] {
  return state.catalog.filter((e) => e.template != null);
}
