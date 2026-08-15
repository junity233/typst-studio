import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * "Open Recent > workspace" (§7.2): after successfully opening a workspace by
 * path, the menu handler must persist it via `record_workspace` (matching
 * `workspaceStore.openWorkspace`) so `session.lastWorkspace` tracks the most
 * recent open and the next launch reopens it — and re-hydrate the
 * project-config store so the Project panel reflects the new root.
 *
 * The payload is EITHER `open-recent:<encodeURIComponent(path)>` (resolved
 * against the FRESH recent list by path equality) or the legacy
 * `open-recent:<integer index>` (an index into the fresh list).
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    invokeMock(cmd, args),
}));

// The module wires menu/close listeners via `@tauri-apps/api/event`'s listen
// (inside useEffect, not invoked here). Stub it so it loads without Tauri.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: vi.fn(async () => {}) }),
}));

const { dispatch } = await import("../useAppCommands");
const { useWorkspaceStore } = await import("../../store/workspaceStore");
const { useProjectConfigStore } = await import("../../store/projectConfigStore");

function seedInvoke(recentWorkspaces: string[], openedRoot: string | null): void {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "get_session":
        return Promise.resolve({
          schemaVersion: 1,
          lastWorkspace: "",
          lastFile: "",
          openDocuments: [],
          activeDocumentId: null,
          windowBounds: null,
          layout: null,
          recentWorkspaces,
        });
      case "open_workspace_by_path":
        // null = path missing / not a directory.
        return Promise.resolve(
          openedRoot === null ? null : { root: openedRoot, name: "opened" },
        );
      case "read_dir":
        return Promise.resolve([]);
      case "record_workspace":
        return Promise.resolve({ recentWorkspaces: [openedRoot ?? ""] });
      case "get_project_config":
        return Promise.resolve(null);
      case "get_project_config_path":
        return Promise.resolve(openedRoot === null ? null : `${openedRoot}/.typstpro`);
      case "list_typ_files":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

/** Flush pending microtasks (the hydrate call is fire-and-forget). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The IPC command names invoked so far (the mock always receives args). */
function invokedCmds(): string[] {
  return invokeMock.mock.calls.map((c) => c[0]);
}

describe("handleOpenRecent persistence", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkspaceStore.setState({
      rootPath: null,
      name: null,
      tree: {},
      expanded: new Set(),
      loading: false,
    });
    useProjectConfigStore.setState({ config: null, configPath: null, typFiles: [] });
  });

  it("records the opened workspace so the next launch reopens it", async () => {
    seedInvoke(["/old/ws"], "/new/ws");

    await dispatch("open-recent:0");

    expect(useWorkspaceStore.getState().rootPath).toBe("/new/ws");
    expect(invokeMock).toHaveBeenCalledWith("record_workspace", {
      workspace: "/new/ws",
    });
  });

  it("does not record when the recent entry no longer exists", async () => {
    seedInvoke(["/gone/ws"], null);

    await dispatch("open-recent:0");

    expect(invokeMock).not.toHaveBeenCalledWith("record_workspace", {
      workspace: "/gone/ws",
    });
  });
});

describe("handleOpenRecent payload forms", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkspaceStore.setState({
      rootPath: null,
      name: null,
      tree: {},
      expanded: new Set(),
      loading: false,
    });
    useProjectConfigStore.setState({ config: null, configPath: null, typFiles: [] });
  });

  it("opens the workspace whose path matches the encoded payload (not an index)", async () => {
    // After opening a new workspace mid-session, a TitleBar-side index refers
    // to a STALE snapshot; the path payload must resolve against the FRESH
    // list. Index 0 here is "/first/ws" but the payload asks for "/second/ws".
    seedInvoke(["/first/ws", "/second/ws"], "/second/ws");

    await dispatch(`open-recent:${encodeURIComponent("/second/ws")}`);

    expect(invokeMock).toHaveBeenCalledWith("open_workspace_by_path", {
      path: "/second/ws",
    });
    expect(useWorkspaceStore.getState().rootPath).toBe("/second/ws");
  });

  it("matches a path payload separator-insensitively (Windows backslashes)", async () => {
    seedInvoke(["C:\\code\\ws"], "C:\\code\\ws");

    await dispatch(`open-recent:${encodeURIComponent("C:/code/ws")}`);

    expect(invokeMock).toHaveBeenCalledWith("open_workspace_by_path", {
      path: "C:\\code\\ws",
    });
  });

  it("silently no-ops when the encoded path is no longer in the recent list", async () => {
    seedInvoke(["/kept/ws"], "/kept/ws");

    await dispatch(`open-recent:${encodeURIComponent("/removed/ws")}`);

    expect(invokeMock).not.toHaveBeenCalledWith("open_workspace_by_path", {
      path: "/removed/ws",
    });
    expect(useWorkspaceStore.getState().rootPath).toBeNull();
  });

  it("still resolves the legacy integer-index payload against the fresh list", async () => {
    seedInvoke(["/zero/ws", "/one/ws"], "/one/ws");

    await dispatch("open-recent:1");

    expect(invokeMock).toHaveBeenCalledWith("open_workspace_by_path", {
      path: "/one/ws",
    });
  });

  it("re-hydrates the project-config store after a successful open", async () => {
    seedInvoke(["/proj/ws"], "/proj/ws");

    await dispatch(`open-recent:${encodeURIComponent("/proj/ws")}`);
    await flushMicrotasks();

    expect(invokedCmds()).toContain("get_project_config_path");
    expect(useProjectConfigStore.getState().configPath).toBe("/proj/ws/.typstpro");
  });

  it("does not hydrate the project config when the entry no longer exists", async () => {
    seedInvoke(["/gone/ws"], null);

    await dispatch("open-recent:0");
    await flushMicrotasks();

    expect(invokedCmds()).not.toContain("get_project_config_path");
    expect(useProjectConfigStore.getState().configPath).toBeNull();
  });
});
