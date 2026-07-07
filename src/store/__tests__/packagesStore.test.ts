import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/tauri", () => ({
  packageListCatalog: vi.fn(),
  packageRefreshIndex: vi.fn(),
  packageListInstalled: vi.fn(),
  packageInstall: vi.fn(),
  packageUninstall: vi.fn(),
}));

import {
  usePackagesStore,
  selectFiltered,
  selectCategories,
} from "../packagesStore";
import {
  packageListCatalog,
  packageListInstalled,
  packageInstall,
} from "../../lib/tauri";

describe("packagesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePackagesStore.setState({
      index: [],
      installed: [],
      // `categories` is required on CatalogFilter, so seed it explicitly.
      filter: { latestOnly: true, categories: [] },
      indexStatus: "idle",
      indexFetchedAt: null,
      installing: {},
      error: null,
      activeTab: "templates",
      selectedKey: null,
    });
  });

  it("loadCatalog populates the full index and sets fresh status", async () => {
    (packageListCatalog as any).mockResolvedValue({
      entries: [
        { name: "cetz", version: "0.4.0", template: null, categories: [] } as any,
      ],
      fetchedAt: 1700000000,
      stale: false,
    });
    await usePackagesStore.getState().loadCatalog();
    expect(usePackagesStore.getState().index).toHaveLength(1);
    expect(usePackagesStore.getState().indexStatus).toBe("fresh");
  });

  it("selectFiltered returns templates for the template view", () => {
    usePackagesStore.setState({
      index: [
        { name: "a", template: { path: "t", entrypoint: "m.typ" }, categories: [] } as any,
        { name: "b", template: null, categories: [] } as any,
      ],
    });
    const templates = selectFiltered(usePackagesStore.getState(), true);
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("a");
  });

  it("selectFiltered applies the category filter (match-any)", () => {
    usePackagesStore.setState({
      index: [
        { name: "a", template: null, categories: ["thesis"] } as any,
        { name: "b", template: null, categories: ["paper"] } as any,
      ],
      filter: { latestOnly: true, categories: ["thesis"] },
    });
    const out = selectFiltered(usePackagesStore.getState(), false);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("a");
  });

  it("selectCategories derives from the FULL index, ignoring the filter", () => {
    // Even with a category filter active, all categories must remain available
    // (regression for the feedback-loop bug).
    usePackagesStore.setState({
      index: [
        { name: "a", template: null, categories: ["thesis", "report"] } as any,
        { name: "b", template: null, categories: ["paper"] } as any,
      ],
      filter: { latestOnly: true, categories: ["thesis"] },
    });
    const cats = selectCategories(usePackagesStore.getState(), false);
    expect(cats).toEqual(["paper", "report", "thesis"]);
  });

  it("install flips the installing flag and reloads installed", async () => {
    (packageInstall as any).mockResolvedValue(undefined);
    (packageListInstalled as any).mockResolvedValue([]);
    await usePackagesStore.getState().install("cetz", "0.4.0");
    expect(usePackagesStore.getState().installing["cetz@0.4.0"]).toBeUndefined();
    expect(packageListInstalled).toHaveBeenCalled();
  });

  it("setFilter merges patches", () => {
    usePackagesStore.getState().setFilter({ query: "thesis" });
    expect(usePackagesStore.getState().filter.query).toBe("thesis");
    expect(usePackagesStore.getState().filter.latestOnly).toBe(true);
  });
});
