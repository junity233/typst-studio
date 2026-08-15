import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `run()` error handling: backend rejections arrive as serialized IpcError
 * objects (§5.3), never `Error` instances — cancellation is signalled by
 * code "cancelled" and must silently return to the picking phase, while a
 * real error must surface its message (not "[object Object]").
 */

const mocks = vi.hoisted(() => ({
  listTypstFiles: vi.fn(),
  exportBatchPdf: vi.fn(),
  openFileByPath: vi.fn(),
  hardCloseTab: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  listTypstFiles: mocks.listTypstFiles,
  exportBatchPdf: mocks.exportBatchPdf,
  openFileByPath: mocks.openFileByPath,
  hardCloseTab: mocks.hardCloseTab,
}));

vi.mock("../../lib/saveDocument", () => ({
  flushDocumentSnapshot: vi.fn(),
}));

import { uniquifyStems, useBatchExportStore } from "../batchExportStore";
import { useDocumentsStore } from "../documentsStore";
import { useTabsStore } from "../tabsStore";

describe("uniquifyStems", () => {
  it("uses the file stem as the output name", () => {
    expect(uniquifyStems(["/ws/notes.typ"])).toEqual([
      { abs: "/ws/notes.typ", name: "notes" },
    ]);
    expect(uniquifyStems(["D:\\ws\\a\\main.typ"])).toEqual([
      { abs: "D:\\ws\\a\\main.typ", name: "main" },
    ]);
  });

  it("disambiguates duplicate stems with -2, -3, … in input order", () => {
    expect(
      uniquifyStems(["/a/main.typ", "/b/main.typ", "/c/main.typ"]),
    ).toEqual([
      { abs: "/a/main.typ", name: "main" },
      { abs: "/b/main.typ", name: "main-2" },
      { abs: "/c/main.typ", name: "main-3" },
    ]);
  });

  it("does not collide with a real suffixed stem (fixpoint bumping)", () => {
    // The generated "main-2" for the second main.typ takes the first free
    // name; the REAL main-2.typ then bumps past it to main-2-2 — uniqueness
    // is the invariant, not who keeps the pretty name.
    expect(
      uniquifyStems(["/a/main.typ", "/b/main.typ", "/c/main-2.typ"]),
    ).toEqual([
      { abs: "/a/main.typ", name: "main" },
      { abs: "/b/main.typ", name: "main-2" },
      { abs: "/c/main-2.typ", name: "main-2-2" },
    ]);
  });

  it("does not collide across distinct stems", () => {
    expect(uniquifyStems(["/a/main.typ", "/a/main-2.typ"])).toEqual([
      { abs: "/a/main.typ", name: "main" },
      { abs: "/a/main-2.typ", name: "main-2" },
    ]);
  });

  it("falls back to 'document' for a bare extension", () => {
    expect(uniquifyStems(["/ws/.typ"])).toEqual([
      { abs: "/ws/.typ", name: "document" },
    ]);
  });
});

describe("batchExportStore error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDocumentsStore.setState({ documents: {} });
    useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
    useBatchExportStore.setState({
      open: true,
      phase: "picking",
      files: [],
      // Empty selection keeps run() focused on exportBatchPdf's rejection
      // (no backend-only tab opening on the side).
      selected: new Set(),
      results: null,
      error: null,
    });
  });

  it("treats a cancelled folder pick as a silent return to picking", async () => {
    mocks.exportBatchPdf.mockRejectedValueOnce({
      code: "cancelled",
      message: "export cancelled",
      recoverable: false,
    });

    await useBatchExportStore.getState().run();

    const s = useBatchExportStore.getState();
    expect(s.phase).toBe("picking");
    expect(s.error).toBeNull();
    expect(s.results).toBeNull();
  });

  it("surfaces a real IpcError object's message (not '[object Object]')", async () => {
    mocks.exportBatchPdf.mockRejectedValueOnce({
      code: "permission_denied",
      message: "cannot write to D:/out",
      recoverable: true,
    });

    await useBatchExportStore.getState().run();

    const s = useBatchExportStore.getState();
    expect(s.phase).toBe("picking");
    expect(s.error).toBe("cannot write to D:/out");
  });

  it("surfaces an IpcError message when the listing fails", async () => {
    mocks.listTypstFiles.mockRejectedValueOnce({
      code: "other",
      message: "workspace not open",
      recoverable: true,
    });

    await useBatchExportStore.getState().openDialog();

    const s = useBatchExportStore.getState();
    expect(s.phase).toBe("picking");
    expect(s.error).toBe("workspace not open");
  });
});
