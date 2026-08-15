import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const {
  resolveExportTargetId,
  resolveConfiguredOutputPath,
  defaultExportFormat,
  runExport,
} = await import("../exportTarget");
const { useDocumentsStore } = await import("../../store/documentsStore");
const { useTabsStore } = await import("../../store/tabsStore");
const { useWorkspaceStore } = await import("../../store/workspaceStore");
const { useProjectConfigStore } = await import("../../store/projectConfigStore");

/** Seed one open document (mirrors saveDocument.test.ts's seed). */
function seedDoc(id: string, path: string, title = "main.typ"): void {
  useDocumentsStore.getState().upsertDocument({
    id,
    title,
    path,
    dirty: true,
    content: "latest frontend text",
    origin: {
      kind: "looseFile",
      path,
      root: "/ws",
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
}

/** Set the active tab (and nothing else) so fallbacks resolve to it. */
function activate(id: string): void {
  useTabsStore.setState({ tabs: [id], hidden: [], activeId: id });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useDocumentsStore.setState({ documents: {} });
  useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
  useWorkspaceStore.setState({ rootPath: null });
  useProjectConfigStore.setState({ config: null, configPath: null, typFiles: [] });
});

describe("resolveExportTargetId", () => {
  it("returns the active tab when no config / no main is configured", () => {
    seedDoc("doc-1", "/ws/other.typ");
    activate("doc-1");
    useWorkspaceStore.setState({ rootPath: "/ws" });

    expect(resolveExportTargetId()).toBe("doc-1");

    useProjectConfigStore.setState({
      config: { schemaVersion: 2, main: null, title: null },
    });
    expect(resolveExportTargetId()).toBe("doc-1");
  });

  it("returns the active tab when a main is configured but no workspace is open", () => {
    seedDoc("doc-1", "/ws/paper.typ");
    activate("doc-1");
    useProjectConfigStore.setState({
      config: { schemaVersion: 2, main: "paper.typ", title: null },
    });

    expect(resolveExportTargetId()).toBe("doc-1");
  });

  it("prefers the open project main file over the active tab", () => {
    seedDoc("paper", "/ws/paper.typ", "paper.typ");
    seedDoc("scratch", "/ws/scratch.typ", "scratch.typ");
    activate("scratch");
    useWorkspaceStore.setState({ rootPath: "/ws" });
    useProjectConfigStore.setState({
      config: { schemaVersion: 2, main: "paper.typ", title: null },
    });

    expect(resolveExportTargetId()).toBe("paper");
  });

  it("falls back to the active tab when the main file is not open", () => {
    seedDoc("scratch", "/ws/scratch.typ", "scratch.typ");
    activate("scratch");
    useWorkspaceStore.setState({ rootPath: "/ws" });
    useProjectConfigStore.setState({
      config: { schemaVersion: 2, main: "paper.typ", title: null },
    });

    expect(resolveExportTargetId()).toBe("scratch");
  });

  it("matches the main file Windows-insensitively (separators and case)", () => {
    seedDoc("paper", "D:/ws/Paper.TYP", "Paper.TYP");
    seedDoc("scratch", "D:/ws/scratch.typ", "scratch.typ");
    activate("scratch");
    useWorkspaceStore.setState({ rootPath: "D:\\ws" });
    useProjectConfigStore.setState({
      config: { schemaVersion: 2, main: "paper.typ", title: null },
    });

    expect(resolveExportTargetId()).toBe("paper");
  });
});

describe("resolveConfiguredOutputPath", () => {
  it("returns undefined without a pattern or without a workspace", () => {
    useWorkspaceStore.setState({ rootPath: "/ws" });
    expect(resolveConfiguredOutputPath()).toBeUndefined();

    useProjectConfigStore.setState({
      config: { schemaVersion: 2, main: null, title: "Paper" },
    });
    expect(resolveConfiguredOutputPath()).toBeUndefined();

    useProjectConfigStore.setState({
      config: {
        schemaVersion: 2,
        main: null,
        title: "Paper",
        export: { outputPath: "build/${title}.pdf" },
      },
    });
    useWorkspaceStore.setState({ rootPath: null });
    expect(resolveConfiguredOutputPath()).toBeUndefined();
  });

  it("expands ${title} and anchors a relative pattern at the workspace root", () => {
    useWorkspaceStore.setState({ rootPath: "/ws" });
    useProjectConfigStore.setState({
      config: {
        schemaVersion: 2,
        main: null,
        title: "Paper",
        export: { outputPath: "build/${title}.pdf" },
      },
    });

    expect(resolveConfiguredOutputPath()).toBe("/ws/build/Paper.pdf");
  });

  it("returns an already-absolute expansion as-is (no re-anchoring)", () => {
    useWorkspaceStore.setState({ rootPath: "/ws" });
    useProjectConfigStore.setState({
      config: {
        schemaVersion: 2,
        main: null,
        title: "Paper",
        export: { outputPath: "D:/out/${title}.pdf" },
      },
    });

    expect(resolveConfiguredOutputPath()).toBe("D:/out/Paper.pdf");
  });
});

describe("defaultExportFormat", () => {
  it("defaults to pdf with no config", () => {
    expect(defaultExportFormat()).toBe("pdf");
  });

  it("normalizes configured formats", () => {
    const setFormat = (format: string) =>
      useProjectConfigStore.setState({
        config: { schemaVersion: 2, main: null, export: { format } },
      });

    setFormat("png");
    expect(defaultExportFormat()).toBe("png");
    setFormat("svg");
    expect(defaultExportFormat()).toBe("svg");
    setFormat("docx");
    expect(defaultExportFormat()).toBe("pdf");
  });
});

describe("runExport", () => {
  it("is a no-op with no open documents and no active tab", async () => {
    await runExport("pdf", true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("flushes the snapshot then exports pdf with the configured output path", async () => {
    seedDoc("doc-1", "/ws/paper.typ", "paper.typ");
    activate("doc-1");
    useWorkspaceStore.setState({ rootPath: "/ws" });
    useProjectConfigStore.setState({
      config: {
        schemaVersion: 2,
        main: "paper.typ",
        title: "Paper",
        export: { outputPath: "build/${title}.pdf" },
      },
    });
    const commands: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      return undefined;
    });

    await runExport("pdf", true);

    expect(commands).toEqual(["update_text", "export_pdf"]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "update_text", {
      id: "doc-1",
      content: "latest frontend text",
      revision: 7,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "export_pdf", {
      id: "doc-1",
      revision: 7,
      outputPath: "/ws/build/Paper.pdf",
    });
  });

  it("passes a null output path when not using the configured path", async () => {
    seedDoc("doc-1", "/ws/paper.typ", "paper.typ");
    activate("doc-1");
    useWorkspaceStore.setState({ rootPath: "/ws" });
    useProjectConfigStore.setState({
      config: {
        schemaVersion: 2,
        main: "paper.typ",
        title: "Paper",
        export: { outputPath: "build/${title}.pdf" },
      },
    });

    await runExport("pdf", false);

    expect(invokeMock).toHaveBeenLastCalledWith("export_pdf", {
      id: "doc-1",
      revision: 7,
      outputPath: null,
    });
  });

  it("dispatches png/svg exports to their own commands", async () => {
    seedDoc("doc-1", "/ws/paper.typ", "paper.typ");
    activate("doc-1");

    await runExport("png", false);
    expect(invokeMock).toHaveBeenLastCalledWith("export_png", {
      id: "doc-1",
      revision: 7,
      outputPath: null,
    });

    invokeMock.mockClear();
    await runExport("svg", false);
    expect(invokeMock).toHaveBeenLastCalledWith("export_svg", {
      id: "doc-1",
      revision: 7,
      outputPath: null,
    });
  });
});
