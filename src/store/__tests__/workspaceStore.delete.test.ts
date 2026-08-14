import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "../workspaceStore";
import { useTabsStore } from "../tabsStore";
import { useDocumentsStore, type Document } from "../documentsStore";

/**
 * Deleting an entry that backs an OPEN document must close that document
 * everywhere (the backend hard-closes it and reports the ids back via
 * `DeleteResult.closedDocIds`; the frontend then drops them from its stores).
 * Regression for the "zombie doc" bug, where a deleted file's tab stayed open,
 * kept its compile worker + watcher tracking, and surfaced a spurious conflict
 * dialog (on Windows the trash op's intermediate events read as `Modified`).
 *
 * Mocked: the IPC layer + session capture, so the path runs without a live
 * Tauri runtime. The `deleteEntry` mock returns the closed-doc ids the backend
 * now reports.
 */
vi.mock("../../lib/tauri", () => ({
  deleteEntry: vi.fn(() =>
    Promise.resolve({ outcome: "trashed", closedDocIds: ["doc1"] }),
  ),
  deleteEntryPermanent: vi.fn(() =>
    Promise.resolve({ outcome: "permanently_deleted", closedDocIds: ["doc1"] }),
  ),
  readDir: vi.fn(() => Promise.resolve([])),
  closeWorkspace: vi.fn(),
  copyEntry: vi.fn(),
  createEntry: vi.fn(),
  getWorkspace: vi.fn(),
  openDefaultWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
  openWorkspaceByPath: vi.fn(),
  renameEntry: vi.fn(),
}));
vi.mock("../../lib/session", () => ({
  captureAndSaveSession: vi.fn(() => Promise.resolve()),
  recordFile: vi.fn(),
  loadSession: vi.fn(),
}));

/** Build a minimal `Document` for seeding the documentsStore map. */
function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc1",
    title: "x.typ",
    path: "/ws/x.typ",
    dirty: false,
    content: "x",
    origin: { kind: "looseFile", path: "/ws/x.typ", root: "/ws" },
    revision: 0,
    compiledRevision: 0,
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
    ...overrides,
  };
}

describe("workspaceStore.deleteEntry closes backing open docs", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
    useDocumentsStore.setState({ documents: {} });
    useWorkspaceStore.setState({ rootPath: "/ws", tree: {} });
  });

  it("removes the closed doc from tabs + documents and re-activates a neighbor", async () => {
    useTabsStore.setState({ tabs: ["other", "doc1"], hidden: [], activeId: "doc1" });
    useDocumentsStore.setState({
      documents: {
        doc1: doc({ id: "doc1" }),
        other: doc({ id: "other", title: "other.typ", path: "/ws/other.typ" }),
      },
    });

    await useWorkspaceStore.getState().deleteEntry("x.typ");

    const tabs = useTabsStore.getState();
    expect(tabs.tabs).not.toContain("doc1");
    expect(tabs.activeId).toBe("other"); // fell back to the survivor
    // The zombie is gone from the documents map too.
    expect(useDocumentsStore.getState().documents.doc1).toBeUndefined();
    expect(useDocumentsStore.getState().documents.other).toBeDefined();
  });

  it("with no survivor leaves activeId null", async () => {
    useTabsStore.setState({ tabs: ["doc1"], hidden: [], activeId: "doc1" });
    useDocumentsStore.setState({ documents: { doc1: doc({ id: "doc1" }) } });

    await useWorkspaceStore.getState().deleteEntry("x.typ");

    const tabs = useTabsStore.getState();
    expect(tabs.tabs).toEqual([]);
    expect(tabs.activeId).toBeNull();
    expect(useDocumentsStore.getState().documents.doc1).toBeUndefined();
  });

  it("no closed docs → no tab changes (delete of a non-open file)", async () => {
    useTabsStore.setState({ tabs: ["other"], hidden: [], activeId: "other" });
    useDocumentsStore.setState({
      documents: { other: doc({ id: "other" }) },
    });
    // Override the mock for this case: nothing open was closed.
    const { deleteEntry } = await import("../../lib/tauri");
    (deleteEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      outcome: "trashed",
      closedDocIds: [],
    });

    await useWorkspaceStore.getState().deleteEntry("unused.typ");

    const tabs = useTabsStore.getState();
    expect(tabs.tabs).toEqual(["other"]);
    expect(tabs.activeId).toBe("other");
  });
});
