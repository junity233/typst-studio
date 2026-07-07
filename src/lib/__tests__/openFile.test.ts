import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentsStore } from "../../store/documentsStore";
import { useTabsStore } from "../../store/tabsStore";
import type { Document } from "../../store/documentsStore";

vi.mock("../tauri", () => ({
  newTab: vi.fn(),
  closeTab: vi.fn(() => Promise.resolve()),
  softCloseTab: vi.fn(() => Promise.resolve()),
  reactivateTab: vi.fn(() => Promise.resolve()),
  hardCloseTab: vi.fn(() => Promise.resolve()),
  openFileByPath: vi.fn(),
  updateText: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("../session", () => ({
  captureAndSaveSession: vi.fn(() => Promise.resolve()),
  recordFile: vi.fn(),
}));

import { openFileByPath, updateText } from "../tauri";
import { openFile } from "../openFile";

function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-1",
    title: "main.typ",
    path: "D:\\tmp\\project\\main.typ",
    dirty: false,
    content: "#let x = 1",
    origin: {
      kind: "workspaceFile",
      path: "D:\\tmp\\project\\main.typ",
      workspace_id: "ws",
    },
    revision: 3,
    compiledRevision: 2,
    conflict: "none",
    conflictDiskContent: null,
    kind: "typst",
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
    ...overrides,
  };
}

describe("openFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
    useDocumentsStore.setState({ documents: {} });
  });

  it("recompiles an already-open Typst file when activating it", async () => {
    useTabsStore.setState({ tabs: ["doc-1"], hidden: [], activeId: null });
    useDocumentsStore.setState({ documents: { "doc-1": doc() } });

    const id = await openFile("D:/tmp/project/main.typ");

    expect(id).toBe("doc-1");
    expect(useTabsStore.getState().activeId).toBe("doc-1");
    expect(openFileByPath).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith("doc-1", "#let x = 1", 3);
  });
});
