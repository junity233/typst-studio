import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Recovery IPC wrappers (§5.1.3 / §5.1.4): each frontend wrapper must forward
 * the right command + args to the backend. We mock `@tauri-apps/api/core`'s
 * `invoke` and assert the wire contract. This mirrors the export-revision test
 * pattern in `tauri.export.test.ts`.
 *
 * Also covers §5.1.4: the close-confirm "Don't Save" path must call
 * `discard_recovery` before close (so the discarded content is not offered
 * again next launch).
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// Import AFTER the mock is registered so the module picks up the mock.
const {
  listRecovery,
  recoverDocument,
  discardRecovery,
  discardAllRecovery,
  compareRecovery,
  markCleanShutdown,
} = await import("../tauri");

function reset(value: unknown = null) {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(value);
}

describe("recovery IPC wrappers (§5.1.3 / §5.1.4)", () => {
  beforeEach(() => reset([]));

  it("listRecovery calls list_recovery", async () => {
    reset([{}]);
    await listRecovery();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("list_recovery");
    expect(args).toBeUndefined();
  });

  it("recoverDocument forwards { id } to recover_document", async () => {
    reset({ documentId: "x", content: "c", title: "t", origin: "untitled" });
    await recoverDocument("doc-1");
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("recover_document");
    expect(args).toEqual({ id: "doc-1" });
  });

  it("discardRecovery forwards { id } to discard_recovery", async () => {
    await discardRecovery("doc-2");
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("discard_recovery");
    expect(args).toEqual({ id: "doc-2" });
  });

  it("discardAllRecovery calls discard_all_recovery", async () => {
    await discardAllRecovery();
    expect(invokeMock.mock.calls[0][0]).toBe("discard_all_recovery");
  });

  it("compareRecovery forwards { id } to compare_recovery", async () => {
    reset({ snapshot: "s", disk: "d" });
    await compareRecovery("doc-3");
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("compare_recovery");
    expect(args).toEqual({ id: "doc-3" });
  });

  it("markCleanShutdown calls mark_clean_shutdown", async () => {
    await markCleanShutdown();
    expect(invokeMock.mock.calls[0][0]).toBe("mark_clean_shutdown");
  });
});
