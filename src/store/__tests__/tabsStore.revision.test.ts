import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTabsStore } from "../tabsStore";
import {
  useDocumentsStore,
  documentFromOpened,
  type Document,
} from "../documentsStore";
import type { OpenedDocument } from "../../lib/types";

// Mock the backend close + session capture so closeTab's async path can be
// exercised without a live Tauri runtime. The mocks resolve cleanly; the
// cross-store cleanup coordination is what we assert.
vi.mock("../../lib/tauri", () => ({ closeTab: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/session", () => ({
  captureAndSaveSession: vi.fn(() => Promise.resolve()),
  recordFile: vi.fn(),
}));

/**
 * Revision coherence (§7 / §16 #5): a stale-revision compile result must never
 * overwrite a newer preview. The domain store bumps `revision` optimistically
 * on every edit, and `setPages`/`setStatus` discard events whose revision is
 * strictly older than the document's current revision.
 *
 * Phase 4 (§10): these mutations now live on the normalized `documentsStore`.
 * The views store (`tabsStore`) holds only the id list + activeId. These tests
 * exercise BOTH: domain behavior via documentsStore, and the views store's id
 * list / activation behavior separately.
 */
function freshDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "tab-1",
    title: "main.typ",
    path: "/x/main.typ",
    dirty: false,
    content: "old",
    revision: 0,
    conflict: "none",
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    ...overrides,
  };
}

/** Build an `OpenedDocument` payload (as the backend would emit) for seeding. */
function openedDoc(over: Partial<OpenedDocument> = {}): OpenedDocument {
  return {
    content: "old",
    id: "tab-1",
    path: "/x/main.typ",
    title: "main.typ",
    dirty: false,
    origin: { kind: "untitled" },
    revision: 0,
    conflict: "none",
    ...over,
  };
}

describe("documentsStore revision guard (§7)", () => {
  beforeEach(() => {
    // Seed the domain map with a single document; the views store with one id.
    useDocumentsStore.setState({
      documents: { "tab-1": freshDocument() },
    });
    useTabsStore.setState({ tabs: ["tab-1"], activeId: "tab-1" });
  });

  it("bumps revision on each distinct edit", () => {
    const store = useDocumentsStore.getState();
    store.updateContent("tab-1", "a");
    store.updateContent("tab-1", "b");
    const doc = useDocumentsStore.getState().documents["tab-1"];
    expect(doc.revision).toBe(2);
    expect(doc.content).toBe("b");
    expect(doc.dirty).toBe(true);
  });

  it("does not bump revision when content is unchanged", () => {
    const store = useDocumentsStore.getState();
    store.updateContent("tab-1", "old"); // same as initial content
    expect(useDocumentsStore.getState().documents["tab-1"].revision).toBe(0);
  });

  it("applies a compiled event matching the current revision", () => {
    useDocumentsStore.setState({
      documents: { "tab-1": freshDocument({ revision: 3 }) },
    });
    useDocumentsStore.getState().setPages("tab-1", 3, ["<svg p3/>"], []);
    const doc = useDocumentsStore.getState().documents["tab-1"];
    expect(doc.svgPages).toEqual(["<svg p3/>"]);
  });

  it("discards a compiled event with a strictly older revision", () => {
    // The user already edited past revision 3 (now at 5); a late-arriving
    // compile tagged revision 3 must NOT clobber the current preview.
    useDocumentsStore.setState({
      documents: {
        "tab-1": freshDocument({ revision: 5, svgPages: ["<svg current/>"] }),
      },
    });
    useDocumentsStore.getState().setPages("tab-1", 3, ["<svg stale/>"], []);
    const doc = useDocumentsStore.getState().documents["tab-1"];
    expect(doc.svgPages).toEqual(["<svg current/>"]);
  });

  it("discards a status event with a strictly older revision", () => {
    useDocumentsStore.setState({
      documents: { "tab-1": freshDocument({ revision: 5, status: "success" }) },
    });
    useDocumentsStore.getState().setStatus("tab-1", 3, "error");
    expect(useDocumentsStore.getState().documents["tab-1"].status).toBe("success");
  });

  it("applies a status event matching the current revision", () => {
    useDocumentsStore.setState({
      documents: { "tab-1": freshDocument({ revision: 4, status: "compiling" }) },
    });
    useDocumentsStore.getState().setStatus("tab-1", 4, "success", 42);
    const doc = useDocumentsStore.getState().documents["tab-1"];
    expect(doc.status).toBe("success");
    expect(doc.durationMs).toBe(42);
  });

  it("ignores events for unknown documents without throwing", () => {
    expect(() =>
      useDocumentsStore.getState().setPages("nope", 1, ["<svg/>"], []),
    ).not.toThrow();
    expect(() =>
      useDocumentsStore.getState().setStatus("nope", 1, "success"),
    ).not.toThrow();
  });
});

describe("documentsStore conflict state (§8.4)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({
      documents: { "tab-1": freshDocument() },
    });
    useTabsStore.setState({ tabs: ["tab-1"], activeId: "tab-1" });
  });

  it("setConflict updates the conflict state", () => {
    useDocumentsStore.setState({
      documents: { "tab-1": freshDocument({ conflict: "none" }) },
    });
    useDocumentsStore.getState().setConflict("tab-1", "modified");
    expect(useDocumentsStore.getState().documents["tab-1"].conflict).toBe("modified");
    useDocumentsStore.getState().setConflict("tab-1", "missing");
    expect(useDocumentsStore.getState().documents["tab-1"].conflict).toBe("missing");
  });

  it("setConflict is a no-op for unknown documents", () => {
    expect(() =>
      useDocumentsStore.getState().setConflict("nope", "modified"),
    ).not.toThrow();
  });

  it("updateContent resets conflict to none (user is editing past it)", () => {
    useDocumentsStore.setState({
      documents: {
        "tab-1": freshDocument({ conflict: "modified", content: "a" }),
      },
    });
    useDocumentsStore.getState().updateContent("tab-1", "b");
    const doc = useDocumentsStore.getState().documents["tab-1"];
    expect(doc.conflict).toBe("none");
    expect(doc.content).toBe("b");
  });

  it("updateContent does not change conflict when content is unchanged", () => {
    useDocumentsStore.setState({
      documents: {
        "tab-1": freshDocument({ conflict: "modified", content: "same" }),
      },
    });
    useDocumentsStore.getState().updateContent("tab-1", "same");
    expect(useDocumentsStore.getState().documents["tab-1"].conflict).toBe("modified");
  });

  it("markSaved clears the conflict (save resolves it)", () => {
    useDocumentsStore.setState({
      documents: {
        "tab-1": freshDocument({ conflict: "missing", dirty: true, content: "x" }),
      },
    });
    useDocumentsStore.getState().markSaved("tab-1", "/x/main.typ");
    const doc = useDocumentsStore.getState().documents["tab-1"];
    expect(doc.conflict).toBe("none");
    expect(doc.dirty).toBe(false);
  });
});

describe("documentsStore open/close lifecycle", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
    useTabsStore.setState({ tabs: [], activeId: null });
  });

  it("openDocument inserts a fresh document seeded with revision 0", () => {
    useDocumentsStore.getState().openDocument(openedDoc({ id: "d1" }));
    const doc = useDocumentsStore.getState().documents["d1"];
    expect(doc).toBeDefined();
    expect(doc.revision).toBe(0);
    expect(doc.svgPages).toEqual([]);
    expect(doc.status).toBe("idle");
  });

  it("closeDocument removes the document", () => {
    useDocumentsStore.getState().openDocument(openedDoc({ id: "d1" }));
    expect(useDocumentsStore.getState().documents["d1"]).toBeDefined();
    useDocumentsStore.getState().closeDocument("d1");
    expect(useDocumentsStore.getState().documents["d1"]).toBeUndefined();
  });

  it("closeDocument is a no-op for an unknown id", () => {
    expect(() => useDocumentsStore.getState().closeDocument("nope")).not.toThrow();
  });

  it("documentFromOpened seeds the canonical blank document", () => {
    const doc = documentFromOpened(openedDoc({ id: "x", title: "t.typ" }));
    expect(doc.id).toBe("x");
    expect(doc.title).toBe("t.typ");
    expect(doc.revision).toBe(0);
    expect(doc.dirty).toBe(false);
  });
});

describe("views store (tabsStore) operates on an id list (§10)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
    useTabsStore.setState({ tabs: [], activeId: null });
  });

  it("activate sets activeId only for an open view", () => {
    useTabsStore.setState({ tabs: ["a", "b"], activeId: "a" });
    useTabsStore.getState().activate("b");
    expect(useTabsStore.getState().activeId).toBe("b");
    // activating an unknown id is a no-op.
    useTabsStore.getState().activate("zzz");
    expect(useTabsStore.getState().activeId).toBe("b");
  });

  it("tabs holds DocumentId references, not full documents", () => {
    useTabsStore.setState({ tabs: ["a", "b", "c"], activeId: "c" });
    const { tabs } = useTabsStore.getState();
    expect(tabs).toEqual(["a", "b", "c"]);
    // Every entry is a plain string id (a view reference), not an object.
    expect(tabs.every((t) => typeof t === "string")).toBe(true);
  });

  it("updateContent delegates to documentsStore (cross-store write)", () => {
    useDocumentsStore.setState({
      documents: { d1: freshDocument({ id: "d1", content: "x", revision: 0 }) },
    });
    useTabsStore.setState({ tabs: ["d1"], activeId: "d1" });
    // Call through the views-store action — it must reach documentsStore.
    useTabsStore.getState().updateContent("d1", "y");
    const doc = useDocumentsStore.getState().documents["d1"];
    expect(doc.content).toBe("y");
    expect(doc.revision).toBe(1);
    expect(doc.dirty).toBe(true);
  });

  it("setPages delegates to documentsStore with the revision guard", () => {
    useDocumentsStore.setState({
      documents: {
        d1: freshDocument({
          id: "d1",
          revision: 2,
          svgPages: ["<current/>"],
        }),
      },
    });
    useTabsStore.setState({ tabs: ["d1"], activeId: "d1" });
    // A stale-revision event (revision 1 < 2) is discarded via delegation.
    useTabsStore.getState().setPages("d1", 1, ["<stale/>"], []);
    expect(useDocumentsStore.getState().documents["d1"].svgPages).toEqual([
      "<current/>",
    ]);
    // A current-revision event applies.
    useTabsStore.getState().setPages("d1", 2, ["<fresh/>"], []);
    expect(useDocumentsStore.getState().documents["d1"].svgPages).toEqual([
      "<fresh/>",
    ]);
  });

  it("closeTab cleans up both stores (views + documents) and reassigns active", async () => {
    // Cross-store coordination (§10): closing a view must drop the id from the
    // views list AND remove the document from the domain store, and reassign
    // activeId when the active view was the one closed.
    useDocumentsStore.setState({
      documents: {
        a: freshDocument({ id: "a", content: "A" }),
        b: freshDocument({ id: "b", content: "B" }),
      },
    });
    useTabsStore.setState({ tabs: ["a", "b"], activeId: "a" });

    await useTabsStore.getState().closeTab("a");

    // Views list no longer references the closed id.
    expect(useTabsStore.getState().tabs).toEqual(["b"]);
    // Domain store no longer holds the document.
    expect(useDocumentsStore.getState().documents["a"]).toBeUndefined();
    // The other document is untouched.
    expect(useDocumentsStore.getState().documents["b"]).toBeDefined();
    // activeId (which pointed at the closed view) reassigned to the survivor.
    expect(useTabsStore.getState().activeId).toBe("b");
  });

  it("closeTab on the last view leaves empty stores and null activeId", async () => {
    useDocumentsStore.setState({
      documents: { only: freshDocument({ id: "only", content: "X" }) },
    });
    useTabsStore.setState({ tabs: ["only"], activeId: "only" });

    await useTabsStore.getState().closeTab("only");

    expect(useTabsStore.getState().tabs).toEqual([]);
    expect(useTabsStore.getState().activeId).toBeNull();
    expect(useDocumentsStore.getState().documents["only"]).toBeUndefined();
  });
});
