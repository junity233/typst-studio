import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    invokeMock(cmd, args),
}));

const { updateText } = await import("../tauri");

describe("versioned update_text IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(0);
  });

  it("forwards the exact content revision that survived debounce", async () => {
    invokeMock.mockResolvedValue(3);

    const acknowledged = await updateText("doc-1", "abc", 3);

    expect(invokeMock).toHaveBeenCalledWith("update_text", {
      id: "doc-1",
      content: "abc",
      revision: 3,
    });
    expect(acknowledged).toBe(3);
  });

  it("does not drop revision zero on an initial replay", async () => {
    await updateText("doc-1", "initial", 0);

    expect(invokeMock).toHaveBeenCalledWith("update_text", {
      id: "doc-1",
      content: "initial",
      revision: 0,
    });
  });
});
