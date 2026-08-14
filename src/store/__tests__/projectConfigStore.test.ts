import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/tauri", () => ({
  getProjectConfig: vi.fn(),
  getProjectConfigPath: vi.fn(),
  listTypFiles: vi.fn(),
  setProjectConfig: vi.fn(),
  setMainFile: vi.fn(),
  clearProjectConfig: vi.fn(),
  onProjectConfigChanged: vi.fn().mockResolvedValue(() => {}),
}));

import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  useProjectConfigStore,
} from "../projectConfigStore";
import {
  getProjectConfig,
  getProjectConfigPath,
  listTypFiles,
  setProjectConfig,
  setMainFile as setMainFileBE,
  clearProjectConfig,
} from "../../lib/tauri";

/**
 * The store follows the live-apply pattern: mutators fire IPC and do NOT touch
 * local state — the `project_config_changed` event round-trip is the single
 * source of truth. These tests cover the hydrate loading path + the mutators'
 * IPC contracts.
 */
describe("projectConfigStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectConfigStore.setState({
      config: null,
      configPath: null,
      typFiles: [],
    });
  });

  it("hydrate loads config, path, and candidate files", async () => {
    (getProjectConfig as any).mockResolvedValue({
      schemaVersion: 1,
      main: "paper.typ",
      title: "T",
    });
    (getProjectConfigPath as any).mockResolvedValue("/ws/.typstpro");
    (listTypFiles as any).mockResolvedValue(["paper.typ", "ch/b.typ"]);

    await useProjectConfigStore.getState().hydrate();

    expect(useProjectConfigStore.getState().config).toEqual({
      schemaVersion: 1,
      main: "paper.typ",
      title: "T",
    });
    expect(useProjectConfigStore.getState().configPath).toBe("/ws/.typstpro");
    expect(useProjectConfigStore.getState().typFiles).toEqual([
      "paper.typ",
      "ch/b.typ",
    ]);
  });

  it("hydrate degrades to null/empty on IPC failure without throwing", async () => {
    (getProjectConfig as any).mockRejectedValue(new Error("boom"));
    (getProjectConfigPath as any).mockRejectedValue(new Error("boom"));
    (listTypFiles as any).mockRejectedValue(new Error("boom"));

    await expect(
      useProjectConfigStore.getState().hydrate(),
    ).resolves.toBeUndefined();
    expect(useProjectConfigStore.getState().config).toBeNull();
    expect(useProjectConfigStore.getState().typFiles).toEqual([]);
  });

  it("update merges a patch over the current config and sends the whole object", async () => {
    (setProjectConfig as any).mockResolvedValue({ schemaVersion: 1 });
    useProjectConfigStore.setState({
      config: { schemaVersion: 1, main: "a.typ", title: "Old" },
    });

    await useProjectConfigStore.getState().update({ title: "New" });

    expect(setProjectConfig).toHaveBeenCalledWith({
      schemaVersion: 1,
      main: "a.typ",
      title: "New",
    });
  });

  it("update starts from defaults when no config exists yet", async () => {
    (setProjectConfig as any).mockResolvedValue({ schemaVersion: 1 });
    useProjectConfigStore.setState({ config: null });

    await useProjectConfigStore.getState().update({ main: "paper.typ" });

    expect(setProjectConfig).toHaveBeenCalledWith({
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      main: "paper.typ",
      title: null,
    });
  });

  it("setMainFile forwards the path (or null) to the backend", async () => {
    (setMainFileBE as any).mockResolvedValue({ schemaVersion: 1 });
    await useProjectConfigStore.getState().setMainFile("b.typ");
    expect(setMainFileBE).toHaveBeenCalledWith("b.typ");

    await useProjectConfigStore.getState().setMainFile(null);
    expect(setMainFileBE).toHaveBeenLastCalledWith(null);
  });

  it("clear calls clearProjectConfig", async () => {
    (clearProjectConfig as any).mockResolvedValue(undefined);
    await useProjectConfigStore.getState().clear();
    expect(clearProjectConfig).toHaveBeenCalled();
  });

  it("refreshTypFiles replaces the candidate list", async () => {
    (listTypFiles as any).mockResolvedValue(["x.typ"]);
    useProjectConfigStore.setState({ typFiles: [] });
    await useProjectConfigStore.getState().refreshTypFiles();
    expect(useProjectConfigStore.getState().typFiles).toEqual(["x.typ"]);
  });
});
