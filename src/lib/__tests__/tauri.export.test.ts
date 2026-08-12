import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Export-bound-to-revision (§9): the frontend export wrappers must forward the
 * caller-supplied `revision` to the backend IPC, so the rendered artifact
 * corresponds to the revision the user is looking at (never silently an older
 * one). We mock `@tauri-apps/api/core`'s `invoke` and assert the `revision`
 * argument reaches the IPC call.
 */

// Capture the most recent invoke call so each test can assert on its args.
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    invokeMock(cmd, args),
}));

// Import AFTER the mock is registered so the module picks up the mock.
const { exportPdf, exportPng, exportSvg, pickImageFile } = await import("../tauri");

function resetWithResolveValue(value: unknown) {
  invokeMock.mockReset();
  // The wrappers `return invoke(...)`; resolve to a known value so the awaited
  // promise settles and we can also assert the resolved payload if useful.
  invokeMock.mockResolvedValue(value);
}

describe("export wrappers forward revision to IPC (§9)", () => {
  beforeEach(() => {
    resetWithResolveValue([]);
  });

  it("exportPdf sends { id, revision, outputPath } to export_pdf", async () => {
    await exportPdf("doc-1", 7);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("export_pdf");
    expect(args).toEqual({ id: "doc-1", revision: 7, outputPath: null });
  });

  it("exportPng sends { id, revision, outputPath } to export_png", async () => {
    await exportPng("doc-2", 13);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("export_png");
    expect(args).toEqual({ id: "doc-2", revision: 13, outputPath: null });
  });

  it("exportSvg sends { id, revision, outputPath } to export_svg", async () => {
    await exportSvg("doc-3", 0);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("export_svg");
    expect(args).toEqual({ id: "doc-3", revision: 0, outputPath: null });
  });

  it("revision 0 is forwarded (not dropped as falsy)", async () => {
    // Guard against a `revision && { revision }` bug that would omit 0.
    await exportPdf("doc-4", 0);
    const [, args] = invokeMock.mock.calls[0];
    expect(args).toHaveProperty("revision", 0);
  });

  it("different revisions are forwarded verbatim (no hardcoding)", async () => {
    await exportPdf("doc-5", 42);
    await exportPdf("doc-5", 43);
    expect(invokeMock.mock.calls[0][1]).toEqual({ id: "doc-5", revision: 42, outputPath: null });
    expect(invokeMock.mock.calls[1][1]).toEqual({ id: "doc-5", revision: 43, outputPath: null });
  });

  it("exportPdf forwards a caller-supplied outputPath", async () => {
    await exportPdf("doc-6", 1, "build/out.pdf");
    const [, args] = invokeMock.mock.calls[0];
    expect(args).toEqual({ id: "doc-6", revision: 1, outputPath: "build/out.pdf" });
  });
});

describe("pickImageFile wrapper (T3)", () => {
  it("invokes pick_image_file with no args", async () => {
    resetWithResolveValue("/abs/path/to/img.png");
    const result = await pickImageFile();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("pick_image_file");
    expect(args).toBeUndefined();
    expect(result).toBe("/abs/path/to/img.png");
  });

  it("forwards a null result (user cancelled) unchanged", async () => {
    resetWithResolveValue(null);
    const result = await pickImageFile();
    expect(result).toBeNull();
  });
});
