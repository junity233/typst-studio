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
  /** The FULL unfiltered index snapshot. Category options and search both
   *  derive from this, so changing the category filter never shrinks the
   *  dropdown (the previous backend-filtered `catalog` caused a feedback loop
   *  where picking a category removed all others from the picker). */
  index: PackageEntry[];
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
  index: [],
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
    if (get().index.length === 0) set({ indexStatus: "loading" });
    try {
      // Fetch the FULL index (empty filter) so category options + search
      // filter against the complete set, not a pre-filtered subset.
      const payload = await packageListCatalogBE({
        latestOnly: true,
        categories: [],
      });
      set({
        index: payload.entries,
        indexFetchedAt: payload.fetchedAt,
        indexStatus: payload.stale ? "stale" : "fresh",
        error: null,
      });
      // §3.2 / §6.1: when there is no cached index yet (stale=true with an
      // empty result), kick off a network refresh so first-use isn't a blank
      // list. Avoid recursing if a refresh is already in flight.
      if (payload.stale && payload.entries.length === 0 && get().indexStatus !== "loading") {
        void get().refreshIndex();
      }
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

/** Filter the full index for a given view (templates-only or packages-only)
 *  by the current filter (query + categories), client-side. The tab decides
 *  template-vs-package; the filter decides text + category. Pure + cheap
 *  (~4000 small objects, sub-millisecond). */
export function selectFiltered(
  state: PackagesState,
  isTemplateView: boolean,
): PackageEntry[] {
  const q = state.filter.query?.trim().toLowerCase();
  const cats = state.filter.categories;
  return state.index.filter((e) => {
    if ((e.template != null) !== isTemplateView) return false;
    if (
      cats.length > 0 &&
      !e.categories.some((c) => cats.includes(c))
    ) {
      return false;
    }
    if (q) {
      const hay = `${e.name} ${e.description ?? ""} ${e.keywords.join(" ")} ${e.authors.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Distinct categories present in the full index for a given view. Used to
 *  populate the category dropdown — derived from the UNFILTERED index so the
 *  picker's options are stable regardless of the current category selection. */
export function selectCategories(
  state: PackagesState,
  isTemplateView: boolean,
): string[] {
  const set = new Set<string>();
  for (const e of state.index) {
    if ((e.template != null) !== isTemplateView) continue;
    for (const c of e.categories) set.add(c);
  }
  return [...set].sort();
}
