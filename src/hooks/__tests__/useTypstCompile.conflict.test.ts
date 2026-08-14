import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  shouldSurfaceConflictDialog,
  handleConflictEvent,
} from "../useTypstCompile";
import type { ConflictPayload, ConflictState } from "../../lib/types";
import { removeDocFromStores } from "../../store/tabsStore";

/**
 * Conflict-event surfacing policy (§5.4 / §8.4).
 *
 * Two layers are exercised here:
 *
 * 1. `shouldSurfaceConflictDialog` — the pure 3-arg policy (doc existence +
 *    hidden set). A doc that no longer exists must never surface a dialog
 *    (the delete flow's invoke response and the watcher's conflict event are
 *    independent IPCs; the later arrival references an already-removed id).
 *
 * 2. `handleConflictEvent` — the REAL handler against the real stores, so the
 *    policy is verified end-to-end instead of re-stating
 *    `!hidden.includes(id)` tautologically: conflict state must be recorded
 *    for live docs (visible or hidden) but never for removed ones, the dialog
 *    must open only for visible docs, and a dialog already up for the same doc
 *    must not be re-opened.
 *
 * 3. `removeDocFromStores` — the cleanup half of the same race: removing a doc
 *    that owns the open conflict dialog must close it (no dangling openForId).
 */

// Stub the Tauri IPC/event transports so importing the hook module (which
// pulls lib/tauri → tabsStore → tauri) loads cleanly under jsdom. The
// listeners themselves aren't exercised here — handleConflictEvent is called
// directly.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const { useDocumentsStore } = await import("../../store/documentsStore");
const { useTabsStore } = await import("../../store/tabsStore");
const { useConflictDialogStore } = await import(
  "../../store/conflictDialogStore"
);

/** A minimal live document for the documents map. */
function seedDoc(id: string, hidden = false): void {
  useDocumentsStore.setState({
    documents: {
      ...useDocumentsStore.getState().documents,
      [id]: {
        id,
        title: `${id}.typ`,
        path: `/x/${id}.typ`,
        dirty: false,
        content: "",
        origin: { kind: "looseFile", path: `/x/${id}.typ`, root: "/x" },
        revision: 1,
        compiledRevision: 1,
        conflict: "none",
        conflictDiskContent: null,
        status: "idle",
        durationMs: null,
        svgPages: [],
        lineMap: [],
        outline: [],
      },
    },
  });
  if (hidden) {
    useTabsStore.setState({ hidden: [...useTabsStore.getState().hidden, id] });
  } else {
    useTabsStore.setState({ tabs: [...useTabsStore.getState().tabs, id] });
  }
}

/** A conflict event for `id` (default: a `modified` conflict with disk text). */
function conflictEvent(id: string, conflict: ConflictState = "modified"): ConflictPayload {
  return { id, revision: 1, conflict, diskContent: "disk text" };
}

/** Reset the three stores the handler touches. */
function resetStores(): void {
  useDocumentsStore.setState({ documents: {} });
  useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
  useConflictDialogStore.setState({ openForId: null, error: null });
}

describe("shouldSurfaceConflictDialog (pure policy)", () => {
  it("surfaces a conflict for an existing, visible doc", () => {
    expect(shouldSurfaceConflictDialog("doc1", [], true)).toBe(true);
    expect(shouldSurfaceConflictDialog("doc1", ["other"], true)).toBe(true);
  });

  it("suppresses the dialog for a soft-closed (hidden) doc", () => {
    expect(shouldSurfaceConflictDialog("doc1", ["doc1"], true)).toBe(false);
    expect(
      shouldSurfaceConflictDialog("doc1", ["old", "doc1", "newer"], true),
    ).toBe(false);
  });

  it("suppresses the dialog for a doc that no longer exists (delete race)", () => {
    // Hidden-ness is irrelevant when the doc is gone: there is nothing to
    // resolve, and opening would leave a dangling openForId.
    expect(shouldSurfaceConflictDialog("doc1", [], false)).toBe(false);
    expect(shouldSurfaceConflictDialog("doc1", ["doc1"], false)).toBe(false);
  });
});

describe("handleConflictEvent (real handler against real stores)", () => {
  beforeEach(resetStores);

  it("records the conflict and opens the dialog for a visible doc", () => {
    seedDoc("doc1");
    handleConflictEvent(conflictEvent("doc1"));
    const doc = useDocumentsStore.getState().documents["doc1"];
    expect(doc?.conflict).toBe("modified");
    expect(doc?.conflictDiskContent).toBe("disk text");
    expect(useConflictDialogStore.getState().openForId).toBe("doc1");
  });

  it("records the conflict but does NOT open the dialog for a hidden doc", () => {
    // Soft-closed: the conflict state must still be recorded (reactivating
    // the tab surfaces it via the StatusBar), but no modal for a "closed"
    // file the user isn't looking at.
    seedDoc("h1", true);
    handleConflictEvent(conflictEvent("h1"));
    const doc = useDocumentsStore.getState().documents["h1"];
    expect(doc?.conflict).toBe("modified");
    expect(useConflictDialogStore.getState().openForId).toBeNull();
  });

  it("drops the event entirely for a doc removed from all stores (delete race)", () => {
    // The doc was never seeded — simulates the watcher's conflict event
    // arriving after the delete response already removed the doc. Neither
    // conflict state nor the dialog may be written for the dead id.
    handleConflictEvent(conflictEvent("gone"));
    expect(useDocumentsStore.getState().documents["gone"]).toBeUndefined();
    expect(useConflictDialogStore.getState().openForId).toBeNull();
  });

  it("does not re-open a dialog that is already up for the same doc", () => {
    seedDoc("doc1");
    // open() resets `error` to null; preset a sentinel error to detect a
    // redundant re-open.
    useConflictDialogStore.setState({ openForId: "doc1", error: "sentinel" });
    handleConflictEvent(conflictEvent("doc1"));
    expect(useConflictDialogStore.getState().openForId).toBe("doc1");
    expect(useConflictDialogStore.getState().error).toBe("sentinel");
  });

  it("does not open the dialog when the conflict resolves to none", () => {
    seedDoc("doc1");
    handleConflictEvent(conflictEvent("doc1", "none"));
    expect(useDocumentsStore.getState().documents["doc1"]?.conflict).toBe(
      "none",
    );
    expect(useConflictDialogStore.getState().openForId).toBeNull();
  });
});

describe("removeDocFromStores (dialog cleanup on delete)", () => {
  beforeEach(resetStores);

  it("closes a conflict dialog whose doc is being removed", () => {
    seedDoc("doc1");
    useConflictDialogStore.setState({ openForId: "doc1" });
    removeDocFromStores("doc1");
    expect(useDocumentsStore.getState().documents["doc1"]).toBeUndefined();
    expect(useConflictDialogStore.getState().openForId).toBeNull();
  });

  it("leaves a dialog for a DIFFERENT doc untouched", () => {
    seedDoc("doc1");
    seedDoc("doc2");
    useConflictDialogStore.setState({ openForId: "doc1" });
    removeDocFromStores("doc2");
    expect(useConflictDialogStore.getState().openForId).toBe("doc1");
  });
});
