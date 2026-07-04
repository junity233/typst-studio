import { describe, it, expect, vi } from "vitest";
import {
  buildOpenDocuments,
  restoreOpenDocuments,
  emptySession,
  type CaptureTab,
} from "../session";
import type { OpenDocRecord } from "../types";

/**
 * Pure session helpers (§13, §16 #8): `buildOpenDocuments` (capture) and
 * `restoreOpenDocuments` (replay). Both are dependency-injected so no Tauri or
 * store mocking is needed. `captureAndSaveSession` (which reads the live store
 * and calls the IPC) is exercised in `session.capture.test.ts`.
 */

function tab(overrides: Partial<CaptureTab>): CaptureTab {
  return {
    id: "t",
    path: null,
    content: "",
    dirty: false,
    ...overrides,
  };
}

describe("buildOpenDocuments (§13)", () => {
  it("maps a path-bearing tab to a Disk record", () => {
    const { openDocuments, activeDocumentId } = buildOpenDocuments(
      [tab({ id: "a", path: "/w/main.typ", content: "irrelevant", dirty: true })],
      "a",
    );
    expect(openDocuments).toEqual([
      { kind: "disk", path: "/w/main.typ", dirty: true },
    ]);
    expect(activeDocumentId).toBe("a");
  });

  it("maps a pathless tab to an Untitled record seeded with content", () => {
    const { openDocuments } = buildOpenDocuments(
      [tab({ id: "u", path: null, content: "draft text", dirty: false })],
      null,
    );
    expect(openDocuments).toEqual([
      { kind: "untitled", content: "draft text", dirty: false },
    ]);
  });

  it("preserves display order across a mixed tab list", () => {
    const tabs: CaptureTab[] = [
      tab({ id: "1", path: "/a.typ", content: "", dirty: false }),
      tab({ id: "2", path: null, content: "scratch", dirty: true }),
      tab({ id: "3", path: "/b.typ", content: "", dirty: true }),
    ];
    const { openDocuments } = buildOpenDocuments(tabs, "3");
    expect(openDocuments).toEqual<OpenDocRecord[]>([
      { kind: "disk", path: "/a.typ", dirty: false },
      { kind: "untitled", content: "scratch", dirty: true },
      { kind: "disk", path: "/b.typ", dirty: true },
    ]);
  });

  it("carries the active id only when it points at an open tab", () => {
    const tabs: CaptureTab[] = [tab({ id: "1", path: "/a.typ" })];
    expect(buildOpenDocuments(tabs, "1").activeDocumentId).toBe("1");
    // Active id references a closed/unknown tab → cleared so restore falls back.
    expect(buildOpenDocuments(tabs, "gone").activeDocumentId).toBeNull();
    expect(buildOpenDocuments(tabs, null).activeDocumentId).toBeNull();
  });
});

describe("restoreOpenDocuments (§13)", () => {
  it("opens disk files via openDisk and untitled via openUntitled, in order", async () => {
    const openDisk = vi.fn(async (path: string) => `disk-${path}`);
    const openUntitled = vi.fn(async (content: string) => `unt-${content}`);
    const records: OpenDocRecord[] = [
      { kind: "disk", path: "/a.typ", dirty: false },
      { kind: "untitled", content: "hi", dirty: false },
      { kind: "disk", path: "/b.typ", dirty: true },
    ];
    const out = await restoreOpenDocuments(records, { openDisk, openUntitled });
    expect(out.failures).toEqual([]);
    expect(out.restored.map((r) => r.id)).toEqual([
      "disk-/a.typ",
      "unt-hi",
      "disk-/b.typ",
    ]);
    expect(openDisk.mock.calls).toEqual([["/a.typ"], ["/b.typ"]]);
    expect(openUntitled.mock.calls).toEqual([["hi"]]);
    // Dirty flag carried through for the re-mark step.
    expect(out.restored[2].dirty).toBe(true);
  });

  it("skips a missing/unreadable disk file and keeps restoring the rest", async () => {
    const openDisk = vi.fn(async (path: string) => {
      if (path === "/gone.typ") throw new Error("ENOENT");
      return `disk-${path}`;
    });
    const openUntitled = vi.fn(async (content: string) => `unt-${content}`);
    const records: OpenDocRecord[] = [
      { kind: "disk", path: "/gone.typ", dirty: false },
      { kind: "untitled", content: "kept", dirty: false },
      { kind: "disk", path: "/ok.typ", dirty: false },
    ];
    const out = await restoreOpenDocuments(records, { openDisk, openUntitled });
    // The failed doc is reported, not thrown; the others succeed.
    expect(out.restored.map((r) => r.id)).toEqual(["unt-kept", "disk-/ok.typ"]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].record).toEqual({
      kind: "disk",
      path: "/gone.typ",
      dirty: false,
    });
  });

  it("returns empty for an empty record list", async () => {
    const out = await restoreOpenDocuments([], {
      openDisk: vi.fn(),
      openUntitled: vi.fn(),
    });
    expect(out.restored).toEqual([]);
    expect(out.failures).toEqual([]);
  });

  it("skips a disk record whose openDisk returns null (§5.1.3 recovery wins)", async () => {
    // Crash-recovery coordination: when a path was already recovered as a dirty
    // in-memory doc, openDisk returns null so the session's disk-reopen is
    // skipped. The skipped record is neither a success nor a failure.
    const openDisk = vi.fn(async (path: string) =>
      path === "/recovered.typ" ? null : `disk-${path}`,
    );
    const openUntitled = vi.fn(async (content: string) => `unt-${content}`);
    const records: OpenDocRecord[] = [
      { kind: "disk", path: "/recovered.typ", dirty: true },
      { kind: "disk", path: "/plain.typ", dirty: false },
    ];
    const out = await restoreOpenDocuments(records, { openDisk, openUntitled });
    expect(out.failures).toEqual([]);
    expect(out.restored.map((r) => r.id)).toEqual(["disk-/plain.typ"]);
    expect(openDisk.mock.calls).toEqual([["/recovered.typ"], ["/plain.typ"]]);
  });
});

describe("emptySession", () => {
  it("has all fields zeroed", () => {
    expect(emptySession()).toEqual({
      // schemaVersion is backend-managed (§7.3); FE sentinel = 0.
      schemaVersion: 0,
      lastWorkspace: "",
      lastFile: "",
      openDocuments: [],
      activeDocumentId: null,
    });
  });
});
