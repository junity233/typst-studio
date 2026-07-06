import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const { flushAndSaveAs, flushAndSaveInPlace } = await import("../saveDocument");
const { saveTab } = await import("../commands");
const { autosaveDirtyDiskDocs } = await import("../../hooks/useAutosave");
const { useDocumentsStore } = await import("../../store/documentsStore");
const { useTabsStore } = await import("../../store/tabsStore");

function seed(id = "doc-1"): void {
  useDocumentsStore.getState().upsertDocument({
    id,
    title: "main.typ",
    path: "/work/main.typ",
    dirty: true,
    content: "latest frontend text",
    origin: {
      kind: "looseFile",
      path: "/work/main.typ",
      root: "/work",
    },
    revision: 7,
    compiledRevision: 6,
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
  });
  useTabsStore.setState({ tabs: [id], hidden: [], activeId: id });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useDocumentsStore.setState({ documents: {} });
  useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
});

describe("save buffer synchronization", () => {
  it("flushes latest content before save_file when preview sync has not run (hidden preview/debounce window)", async () => {
    seed();
    const commands: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      return undefined;
    });

    const saved = await flushAndSaveInPlace("doc-1");

    expect(commands.slice(0, 2)).toEqual(["update_text", "save_file"]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "update_text", {
      id: "doc-1",
      content: "latest frontend text",
      revision: 7,
    });
    expect(saved.revision).toBe(7);
  });

  it("keeps a newer edit dirty when it lands while save_file is in flight", async () => {
    seed();
    let finishSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "save_file") return savePending;
      return Promise.resolve(undefined);
    });

    const saving = saveTab("doc-1");
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_file", { id: "doc-1" });
    });

    useDocumentsStore
      .getState()
      .updateContent("doc-1", "typed while saving");
    finishSave();

    await expect(saving).resolves.toBe(true);
    const doc = useDocumentsStore.getState().documents["doc-1"];
    expect(doc.content).toBe("typed while saving");
    expect(doc.revision).toBe(8);
    expect(doc.dirty).toBe(true);
  });

  it("flushes before Save As and autosave as well", async () => {
    seed();
    const commands: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      if (cmd === "save_as") return "/work/copy.typ";
      return undefined;
    });

    const savedAs = await flushAndSaveAs("doc-1");
    expect(commands.slice(0, 2)).toEqual(["update_text", "save_as"]);
    expect(savedAs.path).toBe("/work/copy.typ");

    commands.length = 0;
    await autosaveDirtyDiskDocs();
    expect(commands.slice(0, 2)).toEqual(["update_text", "save_file"]);
  });
});
