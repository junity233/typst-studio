import { describe, it, expect, vi, beforeEach } from "vitest";
import { workspacePathsEqual } from "../../lib/workspacePath";

/**
 * Mock the stores + IPC wrappers the tools read from. Each mock exposes a
 * `getState` returning the configured state, so tests can mutate the returned
 * object in place between cases.
 */
const docsState: { documents: Record<string, { id: string; content: string; path: string }> } = {
  documents: {},
};
const tabsState: {
  activeId: string | null;
  tabs: string[];
  hidden: string[];
} = { activeId: null, tabs: [], hidden: [] };
const wsState: { rootPath: string | null; name: string | null } = {
  rootPath: "/ws",
  name: "ws",
};
const diagsState: { byDoc: Record<string, unknown> } = { byDoc: {} };

vi.mock("../documentsStore", () => ({
  useDocumentsStore: { getState: () => docsState },
  // Mirror the real helper over the mocked state (same comparator).
  findOpenDocByPath: (absPath: string) =>
    Object.values(docsState.documents).find((d) =>
      workspacePathsEqual((d as { path: string | null }).path, absPath),
    ),
}));
vi.mock("../tabsStore", () => ({
  useTabsStore: { getState: () => tabsState },
}));
vi.mock("../workspaceStore", () => ({
  useWorkspaceStore: { getState: () => wsState },
}));
vi.mock("../diagnosticsStore", () => ({
  useDiagnosticsStore: { getState: () => diagsState },
  selectDiagnosticsForDoc: (doc: unknown) =>
    (doc as { combined?: unknown[] })?.combined ?? [],
}));
vi.mock("../../lib/tauri", () => ({
  openFileByPath: vi.fn(),
  searchWorkspace: vi.fn(),
  updateText: vi.fn(),
  // readForContent chains `.catch()` on the result — the mock must return a
  // Promise like the real IPC wrapper does.
  hardCloseTab: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../components/Editor/editorApiRef", () => ({
  editorApiRef: {
    current: {
      getCurrentLine: () => 3,
      getSelectionText: () => "sel",
    },
    pendingReveal: null,
  },
}));

const { openFileByPath, searchWorkspace, hardCloseTab } = await import("../../lib/tauri");
// Re-import after mocks.
const { buildTools: buildToolsReal } = await import("../assistantTools");
import type { ToolContext } from "../assistantTools";

function makeCtx(): ToolContext {
  return {
    requestApproval: vi.fn().mockResolvedValue("Edit applied."),
  };
}

function resetState() {
  docsState.documents = {};
  tabsState.activeId = null;
  tabsState.tabs = [];
  tabsState.hidden = [];
  wsState.rootPath = "/ws";
  wsState.name = "ws";
  diagsState.byDoc = {};
}

describe("assistantTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("read_file prefers open-tab content over IPC", async () => {
    docsState.documents = {
      doc1: { id: "doc1", content: "open content", path: "/ws/a.typ" },
    };
    const tools = buildToolsReal(makeCtx());
    const rf = tools.find((t) => t.name === "read_file")!;
    const result = await rf.execute("call-1", { path: "a.typ" }, undefined);
    expect(result.content[0]).toMatchObject({ text: "open content" });
    expect(openFileByPath).not.toHaveBeenCalled();
  });

  it("read_file falls back to openFileByPath when not open", async () => {
    (openFileByPath as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "x",
      content: "from disk",
      path: "/ws/b.typ",
    });
    const tools = buildToolsReal(makeCtx());
    const rf = tools.find((t) => t.name === "read_file")!;
    const result = await rf.execute("call-1", { path: "b.typ" }, undefined);
    expect(result.content[0]).toMatchObject({ text: "from disk" });
    expect(openFileByPath).toHaveBeenCalledWith("/ws/b.typ");
  });

  it("read_file hard-closes the backend-only tab it opened for an unknown file", async () => {
    // The id the backend handed back is unknown to the frontend (no tab, not
    // hidden) → the worker must be released, mirroring batchExportStore's
    // closeAfterwards + hardCloseTab pattern.
    (openFileByPath as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "x",
      content: "from disk",
      path: "/ws/b.typ",
    });
    const tools = buildToolsReal(makeCtx());
    const rf = tools.find((t) => t.name === "read_file")!;
    const result = await rf.execute("call-1", { path: "b.typ" }, undefined);
    expect(result.content[0]).toMatchObject({ text: "from disk" });
    expect(hardCloseTab).toHaveBeenCalledWith("x");
  });

  it("read_file keeps the doc when the backend deduped onto a known tab id", async () => {
    // Defensive race: the path wasn't in documents at check time, but the
    // backend returned an id the frontend already tracks (a visible tab or a
    // hidden doc) — its state must survive, so NO hard close.
    tabsState.tabs = ["known"];
    (openFileByPath as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "known",
      content: "tab content",
      path: "/ws/b.typ",
    });
    const tools = buildToolsReal(makeCtx());
    const rf = tools.find((t) => t.name === "read_file")!;
    const result = await rf.execute("call-1", { path: "b.typ" }, undefined);
    expect(result.content[0]).toMatchObject({ text: "tab content" });
    expect(hardCloseTab).not.toHaveBeenCalled();
  });

  it("read_file keeps the doc when the backend deduped onto a hidden id", async () => {
    tabsState.hidden = ["hid"];
    (openFileByPath as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "hid",
      content: "hidden content",
      path: "/ws/b.typ",
    });
    const tools = buildToolsReal(makeCtx());
    const rf = tools.find((t) => t.name === "read_file")!;
    const result = await rf.execute("call-1", { path: "b.typ" }, undefined);
    expect(result.content[0]).toMatchObject({ text: "hidden content" });
    expect(hardCloseTab).not.toHaveBeenCalled();
  });

  it("read_file rejects paths outside the workspace", async () => {
    const tools = buildToolsReal(makeCtx());
    const rf = tools.find((t) => t.name === "read_file")!;
    await expect(
      rf.execute("call-1", { path: "../etc/passwd" }, undefined),
    ).rejects.toThrow(/outside/i);
  });

  it("edit throws ToolError when old_string not found", async () => {
    docsState.documents = {
      doc1: { id: "doc1", content: "hello world", path: "/ws/a.typ" },
    };
    tabsState.activeId = "doc1";
    const ctx = makeCtx();
    const tools = buildToolsReal(ctx);
    const edit = tools.find((t) => t.name === "edit")!;
    await expect(
      edit.execute("c1", { old_string: "missing", new_string: "x" }, undefined),
    ).rejects.toThrow(/not found/i);
    expect(ctx.requestApproval).not.toHaveBeenCalled();
  });

  it("edit throws ToolError when old_string matches multiple times", async () => {
    docsState.documents = {
      doc1: { id: "doc1", content: "foo bar foo", path: "/ws/a.typ" },
    };
    tabsState.activeId = "doc1";
    const tools = buildToolsReal(makeCtx());
    const edit = tools.find((t) => t.name === "edit")!;
    await expect(
      edit.execute("c1", { old_string: "foo", new_string: "x" }, undefined),
    ).rejects.toThrow(/matches 2 places|include more/i);
  });

  it("edit requests approval with diff payload when unique", async () => {
    docsState.documents = {
      doc1: { id: "doc1", content: "= Heading\nbody", path: "/ws/a.typ" },
    };
    tabsState.activeId = "doc1";
    const ctx = makeCtx();
    const tools = buildToolsReal(ctx);
    const edit = tools.find((t) => t.name === "edit")!;
    const result = await edit.execute(
      "c1",
      { old_string: "= Heading", new_string: "= Heading <large>" },
      undefined,
    );
    expect(result.content[0]).toMatchObject({ text: "Edit applied." });
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "edit",
        path: "/ws/a.typ",
        old_string: "= Heading",
        new_string: "= Heading <large>",
        before: "= Heading\nbody",
      }),
    );
  });

  it("write_file rejects when an open tab is at that path", async () => {
    docsState.documents = {
      doc1: { id: "doc1", content: "x", path: "/ws/existing.typ" },
    };
    tabsState.activeId = "doc1";
    const ctx = makeCtx();
    const tools = buildToolsReal(ctx);
    const wf = tools.find((t) => t.name === "write_file")!;
    await expect(
      wf.execute("c1", { path: "existing.typ", content: "y" }, undefined),
    ).rejects.toThrow(/exists|use `edit`/i);
    expect(ctx.requestApproval).not.toHaveBeenCalled();
  });

  it("write_file requests approval for a new path", async () => {
    const ctx = makeCtx();
    const tools = buildToolsReal(ctx);
    const wf = tools.find((t) => t.name === "write_file")!;
    const result = await wf.execute(
      "c1",
      { path: "new.typ", content: "hello" },
      undefined,
    );
    expect(result.content[0]).toMatchObject({ text: "Edit applied." });
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "write_file",
        path: "/ws/new.typ",
        after: "hello",
      }),
    );
  });

  it("get_active_file returns path/content/cursorLine/selection", async () => {
    docsState.documents = {
      doc1: { id: "doc1", content: "hello", path: "/ws/a.typ" },
    };
    tabsState.activeId = "doc1";
    const tools = buildToolsReal(makeCtx());
    const gaf = tools.find((t) => t.name === "get_active_file")!;
    const result = await gaf.execute("c1", {}, undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({
      path: "/ws/a.typ",
      content: "hello",
      cursorLine: 3,
      selection: "sel",
    });
  });

  it("get_active_file reports none when no active tab", async () => {
    tabsState.activeId = null;
    const tools = buildToolsReal(makeCtx());
    const gaf = tools.find((t) => t.name === "get_active_file")!;
    const result = await gaf.execute("c1", {}, undefined);
    expect((result.content[0] as { text: string }).text).toBe("No active file.");
  });

  it("get_diagnostics reports clean when empty", async () => {
    tabsState.activeId = "doc1";
    diagsState.byDoc = { doc1: { combined: [] } };
    const tools = buildToolsReal(makeCtx());
    const gd = tools.find((t) => t.name === "get_diagnostics")!;
    const result = await gd.execute("c1", {}, undefined);
    expect((result.content[0] as { text: string }).text).toContain("cleanly");
  });

  it("search_files forwards a SearchQuery to searchWorkspace", async () => {
    (searchWorkspace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { relative: "a.typ", line: 4, lineText: "  hello world" },
    ]);
    const tools = buildToolsReal(makeCtx());
    const sf = tools.find((t) => t.name === "search_files")!;
    const result = await sf.execute("c1", { query: "hello" }, undefined);
    expect(searchWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "hello", isRegex: false }),
    );
    expect((result.content[0] as { text: string }).text).toContain("a.typ:4");
  });
});
