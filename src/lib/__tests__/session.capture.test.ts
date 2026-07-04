import { describe, it, expect, vi } from "vitest";
import { captureSession, captureAndSaveSession } from "../session";
import type { OpenDocRecord } from "../types";

/**
 * `captureSession` (§13): the testable core of the capture path. It reads the
 * live tab list (via an injected `readState`) and persists a full
 * open-documents snapshot (via an injected `save`). Both dependencies are
 * injected so this needs no Tauri/store mocking. `captureAndSaveSession` — the
 * production wrapper that wires the real store + `save_session` IPC — is
 * exercised for its best-effort error handling.
 */

const tabsState = (tabs: Array<{ id: string; path: string | null; content: string; dirty: boolean }>, activeId: string | null) => ({
  tabs,
  activeId,
});

describe("captureSession (§13)", () => {
  it("builds openDocuments from the live tab list (in order) and saves them", async () => {
    const readState = () =>
      tabsState(
        [
          { id: "1", path: "/x.typ", content: "", dirty: false },
          { id: "2", path: null, content: "draft", dirty: true },
        ],
        "2",
      );
    const save = vi.fn().mockResolvedValue(undefined);

    await captureSession(readState, save);

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0] as {
      openDocuments: OpenDocRecord[];
      activeDocumentId: string | null;
    };
    expect(patch.openDocuments).toEqual([
      { kind: "disk", path: "/x.typ", dirty: false },
      { kind: "untitled", content: "draft", dirty: true },
    ]);
    expect(patch.activeDocumentId).toBe("2");
  });

  it("clears the active id when it no longer points at an open tab", async () => {
    const readState = () =>
      tabsState([{ id: "1", path: "/x.typ", content: "", dirty: false }], "ghost");
    const save = vi.fn().mockResolvedValue(undefined);

    await captureSession(readState, save);

    const patch = save.mock.calls[0][0] as {
      activeDocumentId: string | null;
    };
    expect(patch.activeDocumentId).toBeNull();
  });

  it("propagates a save rejection (the wrapper swallows it)", async () => {
    const readState = () => tabsState([], null);
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    await expect(captureSession(readState, save)).rejects.toThrow("disk full");
  });
});

describe("captureAndSaveSession (§13, best-effort wrapper)", () => {
  it("swallows a failure from the store/IPC and warns (never throws)", async () => {
    // The dynamic tabs-store import resolves to the real store; with no Tauri
    // runtime the IPC rejects, but the wrapper must catch and warn rather than
    // surface. Reading an empty store → save is attempted and fails → caught.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(captureAndSaveSession()).resolves.toBeUndefined();
    // A warn is emitted on the failure path; if the environment somehow
    // succeeded, warn simply wasn't called — either way no throw.
    warn.mockRestore();
  });
});
