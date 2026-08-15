import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "../workspaceStore";

/**
 * Pins the programmatic workspace open (open-recent menu, package template
 * init): the store action owns the whole adopt tail — state swap, tree
 * refresh, recent-list recording, project-config re-hydrate — so external
 * callers can't drift from `openWorkspace` (the template-init site used to
 * skip `recordWorkspace`, so template projects never reached Open Recent).
 *
 * Mocked: the IPC layer (tauri wrappers) + session + project-config store.
 */
const openByPath = vi.fn();
const readDir = vi.fn(() => Promise.resolve([]));
const recordWorkspace = vi.fn();
const configHydrate = vi.fn();

vi.mock("../../lib/tauri", () => ({
  openWorkspaceByPath: (...args: unknown[]) => openByPath(...args),
  readDir: () => readDir(),
  closeWorkspace: vi.fn(),
  copyEntry: vi.fn(),
  createEntry: vi.fn(),
  getWorkspace: vi.fn(),
  openDefaultWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
  renameEntry: vi.fn(),
}));
vi.mock("../../lib/session", () => ({
  captureAndSaveSession: vi.fn(() => Promise.resolve()),
  recordFile: vi.fn(),
  recordWorkspace: (root: string) => recordWorkspace(root),
  loadSession: vi.fn(),
}));
vi.mock("../projectConfigStore", () => ({
  useProjectConfigStore: { getState: () => ({ hydrate: configHydrate }) },
}));

describe("workspaceStore.openWorkspaceByPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      rootPath: null,
      name: null,
      tree: {},
      expanded: new Set<string>(),
    });
  });

  it("adopts the opened meta: state swap, root refresh, recent entry, config hydrate", async () => {
    openByPath.mockResolvedValue({ root: "D:\\tmp\\proj", name: "proj" });

    const ok = await useWorkspaceStore.getState().openWorkspaceByPath("D:\\tmp\\proj");

    expect(ok).toBe(true);
    expect(openByPath).toHaveBeenCalledWith("D:\\tmp\\proj");
    const s = useWorkspaceStore.getState();
    expect(s.rootPath).toBe("D:\\tmp\\proj");
    expect(s.name).toBe("proj");
    expect(s.tree).toEqual({ "": [] });
    expect(recordWorkspace).toHaveBeenCalledWith("D:\\tmp\\proj");
    expect(configHydrate).toHaveBeenCalledTimes(1);
  });

  it("reports false and adopts nothing when the backend returns no meta", async () => {
    openByPath.mockResolvedValue(null);

    const ok = await useWorkspaceStore.getState().openWorkspaceByPath("/nope");

    expect(ok).toBe(false);
    expect(useWorkspaceStore.getState().rootPath).toBeNull();
    expect(recordWorkspace).not.toHaveBeenCalled();
    expect(configHydrate).not.toHaveBeenCalled();
  });
});
