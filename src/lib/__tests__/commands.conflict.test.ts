import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * §5.4 / §11.3: the SaveCoordinator gate rejects an in-place save for a
 * conflicted doc with `ExternalConflict`. `saveTab` must catch that code and
 * OPEN THE CONFLICT DIALOG instead of alerting (and return false so a Save-All
 * loop doesn't treat it as saved). The conflict state itself stays set.
 *
 * We mock `@tauri-apps/api/core`'s `invoke` so `save_file` rejects with an
 * `external_conflict` IpcError, then assert the conflict-dialog store opens for
 * the doc and `saveTab` returns false. A `permission_denied` error must NOT
 * open the conflict dialog (it takes the Save-As-recovery branch instead).
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
// Stub the event/window APIs so the commands module loads cleanly.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: vi.fn(async () => {}) }),
}));

const { saveTab } = await import("../commands");
const { useDocumentsStore } = await import("../../store/documentsStore");
const { useTabsStore } = await import("../../store/tabsStore");
const { useDialogStore } = await import("../../store/dialogStore");
const { useConflictDialogStore } = await import("../../store/conflictDialogStore");

function reset() {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useDialogStore.getState().resolve("cancel");
  useConflictDialogStore.getState().close();
}

function seedTitledDoc(id: string, path: string, conflict: "none" | "modified"): void {
  useDocumentsStore.getState().upsertDocument({
    id,
    title: path.split("/").pop() ?? "doc.typ",
    path,
    dirty: true,
    content: "buffer edits",
    // §17 origin mirror: these are disk-backed test docs → looseFile rooted at
    // the parent dir (matches what documentUri.ts would convert to a file: URI).
    origin: { kind: "looseFile", path, root: parentDir(path) },
    revision: 1,
    conflict,
    conflictDiskContent: conflict === "modified" ? "disk content" : null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
  });
  useTabsStore.setState({ tabs: [id], activeId: id });
}

/** Parent directory of a POSIX-style test path (no Windows separators here). */
function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : p;
}

describe("saveTab opens the conflict dialog on ExternalConflict (§5.4)", () => {
  beforeEach(() => {
    reset();
    useDocumentsStore.getState().documents = {};
    useTabsStore.setState({ tabs: [], activeId: null });
  });

  it("external_conflict → opens dialog, returns false, conflict stays set", async () => {
    seedTitledDoc("doc-c", "/w/notes.typ", "modified");
    // save_file rejects with the ExternalConflict IpcError shape.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "save_file") {
        return Promise.reject({
          code: "external_conflict",
          message: "in-place save blocked: conflict active",
          recoverable: true,
        });
      }
      return Promise.resolve(undefined);
    });

    const ok = await saveTab("doc-c");

    expect(ok).toBe(false);
    // The conflict dialog opened for THIS doc.
    expect(useConflictDialogStore.getState().openForId).toBe("doc-c");
    // The conflict state itself was NOT cleared (gate keeps blocking).
    expect(useDocumentsStore.getState().documents["doc-c"].conflict).toBe("modified");
  });

  it("non-conflict code (permission_denied) does NOT open the conflict dialog", async () => {
    seedTitledDoc("doc-p", "/w/locked.typ", "none");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "save_file") {
        return Promise.reject({
          code: "permission_denied",
          message: "permission denied",
          recoverable: true,
        });
      }
      return Promise.resolve(undefined);
    });

    // permission_denied takes the Save-As-recovery branch, which awaits a
    // confirm() choice. Resolve it as cancel so saveTab settles — we're only
    // asserting the conflict dialog never opened for this code. Yield a tick
    // first so saveTab reaches the confirm() call and registers the request.
    const saving = saveTab("doc-p");
    await Promise.resolve();
    await Promise.resolve();
    useDialogStore.getState().resolve("cancel");
    const ok = await saving;

    expect(ok).toBe(false);
    // The conflict store stays closed for a non-conflict code.
    expect(useConflictDialogStore.getState().openForId).toBeNull();
  });

  it("successful save does NOT open the conflict dialog", async () => {
    seedTitledDoc("doc-ok", "/w/ok.typ", "none");
    invokeMock.mockResolvedValue(undefined);

    const ok = await saveTab("doc-ok");

    expect(ok).toBe(true);
    expect(useConflictDialogStore.getState().openForId).toBeNull();
  });
});
