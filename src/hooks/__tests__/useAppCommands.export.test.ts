import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Export dispatch (§9): the menu dispatcher must read the active tab's current
 * `revision` from the store and forward it to the export IPC commands, so the
 * backend renders exactly the revision the user is looking at.
 *
 * We mock `@tauri-apps/api/core`'s `invoke` (the IPC transport) and seed the
 * tabs store with a known revision, then dispatch the export menu ids and
 * assert the revision reaches invoke.
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    invokeMock(cmd, args),
}));

// `dispatch` is a pure function but the module also wires menu/close listeners
// via `@tauri-apps/api/event`'s `listen` (inside useEffect, not invoked here).
// Stub it so the module loads cleanly without Tauri.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: vi.fn(async () => {}) }),
}));

const { dispatch } = await import("../useAppCommands");
const { useTabsStore } = await import("../../store/tabsStore");
const { useDocumentsStore } = await import("../../store/documentsStore");

function seedActiveTab(revision: number): void {
  // Phase 4: domain state (incl. revision) lives in documentsStore; the views
  // store holds only the id list + activeId. Seed both so dispatch resolves the
  // active document and reads its revision.
  useDocumentsStore.setState({
    documents: {
      active: {
        id: "active",
        title: "main.typ",
        path: "/x/main.typ",
        dirty: false,
        content: "",
        revision,
        conflict: "none",
        conflictDiskContent: null,
        status: "idle",
        durationMs: null,
        svgPages: [],
        lineMap: [],
      },
    },
  });
  useTabsStore.setState({ tabs: ["active"], activeId: "active" });
}

describe("dispatch forwards active tab revision to export IPC (§9)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  it("export-pdf forwards the active tab's revision", async () => {
    seedActiveTab(11);
    await dispatch("export-pdf");
    expect(invokeMock).toHaveBeenCalledWith("export_pdf", {
      id: "active",
      revision: 11,
    });
  });

  it("export-png forwards the active tab's revision", async () => {
    seedActiveTab(22);
    await dispatch("export-png");
    expect(invokeMock).toHaveBeenCalledWith("export_png", {
      id: "active",
      revision: 22,
    });
  });

  it("export-svg forwards the active tab's revision", async () => {
    seedActiveTab(33);
    await dispatch("export-svg");
    expect(invokeMock).toHaveBeenCalledWith("export_svg", {
      id: "active",
      revision: 33,
    });
  });

  it("forwards revision 0 (no falsy-drop bug)", async () => {
    seedActiveTab(0);
    await dispatch("export-pdf");
    expect(invokeMock).toHaveBeenCalledWith("export_pdf", {
      id: "active",
      revision: 0,
    });
  });

  it("does not export when there is no active tab", async () => {
    useDocumentsStore.setState({ documents: {} });
    useTabsStore.setState({ tabs: [], activeId: null });
    await dispatch("export-pdf");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
