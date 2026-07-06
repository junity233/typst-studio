import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTabsStore } from "../tabsStore";
import {
  useDocumentsStore,
  type Document,
} from "../documentsStore";
import type { OpenedDocument } from "../../lib/types";

/**
 * Phase B2 (tab soft-close): closing a tab leaves the strip but keeps its
 * backend state (worker/world/compile result) AND frontend state (documents[id]
 * entry) alive, so reopening the same file re-activates the hidden doc —
 * instant, no "No preview yet" loading. Hidden docs are capped at 10 (LRU):
 * when an 11th is soft-closed, the oldest is hard-closed (true destroy).
 *
 * The tabsStore owns `hidden: DocumentId[]` (LRU order: index 0 = oldest). The
 * documentsStore entry is preserved across soft-close (only hardClose deletes
 * it). Mocked here: the IPC layer + session capture, so the soft-close path
 * can be exercised without a live Tauri runtime.
 */
vi.mock("../../lib/tauri", () => ({
  softCloseTab: vi.fn(() => Promise.resolve()),
  reactivateTab: vi.fn(() =>
    Promise.resolve({
      id: "doc1",
      content: "x",
      path: "/x.typ",
      title: "x.typ",
      dirty: false,
      origin: { kind: "looseFile", path: "/x.typ", root: "/" },
      revision: 0,
      conflict: "none",
      hidden: false,
    } satisfies OpenedDocument),
  ),
  hardCloseTab: vi.fn(() => Promise.resolve()),
  closeTab: vi.fn(() => Promise.resolve()),
  newTab: vi.fn(),
  openFileByPath: vi.fn(),
}));
vi.mock("../../lib/session", () => ({
  captureAndSaveSession: vi.fn(() => Promise.resolve()),
  recordFile: vi.fn(),
}));

/** Build a minimal `Document` for seeding the documentsStore map. */
function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc1",
    title: "x.typ",
    path: "/x.typ",
    dirty: false,
    content: "x",
    origin: { kind: "looseFile", path: "/x.typ", root: "/" },
    revision: 0,
    compiledRevision: 0,
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
    ...overrides,
  };
}

describe("tabsStore soft-close (Phase B2)", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
    useDocumentsStore.setState({ documents: {} });
  });

  it("softClose moves a tab from tabs[] to hidden[] without deleting the document", async () => {
    useTabsStore.setState({ tabs: ["doc1"], hidden: [], activeId: "doc1" });
    useDocumentsStore.setState({ documents: { doc1: doc({ id: "doc1" }) } });

    await useTabsStore.getState().softClose("doc1");

    const s = useTabsStore.getState();
    expect(s.tabs).not.toContain("doc1");
    expect(s.hidden).toContain("doc1");
    // Document entry preserved (soft-close keeps frontend state alive).
    expect(useDocumentsStore.getState().documents.doc1).toBeDefined();
  });

  it("softClose picks a sensible new activeId when closing the active tab (last survivor)", async () => {
    useTabsStore.setState({
      tabs: ["a", "b", "c"],
      hidden: [],
      activeId: "b",
    });

    await useTabsStore.getState().softClose("b");

    const s = useTabsStore.getState();
    expect(s.tabs).toEqual(["a", "c"]);
    // Active falls to the last remaining (matches existing closeTab behavior).
    expect(s.activeId).toBe("c");
  });

  it("softClose with no survivor leaves activeId null", async () => {
    useTabsStore.setState({ tabs: ["only"], hidden: [], activeId: "only" });

    await useTabsStore.getState().softClose("only");

    const s = useTabsStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeId).toBeNull();
    expect(s.hidden).toEqual(["only"]);
  });

  it("reactivate moves a doc from hidden[] back to tabs[] and sets it active", async () => {
    useTabsStore.setState({ tabs: [], hidden: ["doc1"], activeId: null });

    await useTabsStore.getState().reactivate("doc1");

    const s = useTabsStore.getState();
    expect(s.tabs).toContain("doc1");
    expect(s.hidden).not.toContain("doc1");
    expect(s.activeId).toBe("doc1");
  });

  it("reactivate a doc already visible just activates it (no dup in tabs[])", async () => {
    useTabsStore.setState({
      tabs: ["doc1", "other"],
      hidden: [],
      activeId: "other",
    });

    await useTabsStore.getState().reactivate("doc1");

    const s = useTabsStore.getState();
    expect(s.tabs).toEqual(["doc1", "other"]);
    expect(s.activeId).toBe("doc1");
  });

  it("LRU eviction: soft-closing an 11th doc hard-closes the oldest hidden", async () => {
    // Seed: 10 hidden docs (old0..old9), one visible tab "new".
    const hidden = Array.from({ length: 10 }, (_, i) => `old${i}`);
    useTabsStore.setState({ tabs: ["new"], hidden, activeId: "new" });
    // Seed documents for the evicted doc + "new" so hardClose can clean up.
    useDocumentsStore.setState({
      documents: {
        old0: doc({ id: "old0" }),
        new: doc({ id: "new" }),
      },
    });

    // soft-close "new" → hidden grows to 11 → oldest (old0) hard-closed.
    await useTabsStore.getState().softClose("new");

    const s = useTabsStore.getState();
    expect(s.hidden).not.toContain("old0"); // evicted (true destroy)
    expect(s.hidden).toContain("new"); // newest kept
    expect(s.hidden.length).toBe(10); // cap held
    // The evicted doc's document entry is gone (hardClose deletes it).
    expect(useDocumentsStore.getState().documents.old0).toBeUndefined();
  });

  it("hardClose truly destroys: removes from tabs[]/hidden[] and deletes the document entry", async () => {
    useTabsStore.setState({
      tabs: ["a"],
      hidden: ["b"],
      activeId: "a",
    });
    useDocumentsStore.setState({
      documents: { a: doc({ id: "a" }), b: doc({ id: "b" }) },
    });

    await useTabsStore.getState().hardClose("b");

    const s = useTabsStore.getState();
    expect(s.hidden).not.toContain("b");
    expect(useDocumentsStore.getState().documents.b).toBeUndefined();
    // The other doc is untouched.
    expect(useDocumentsStore.getState().documents.a).toBeDefined();
  });

  it("closeTab (X button) now soft-closes by default (document survives)", async () => {
    useTabsStore.setState({ tabs: ["doc1"], hidden: [], activeId: "doc1" });
    useDocumentsStore.setState({ documents: { doc1: doc({ id: "doc1" }) } });

    await useTabsStore.getState().closeTab("doc1");

    const s = useTabsStore.getState();
    expect(s.tabs).not.toContain("doc1");
    expect(s.hidden).toContain("doc1");
    // Soft-close keeps the document entry alive.
    expect(useDocumentsStore.getState().documents.doc1).toBeDefined();
  });
});
