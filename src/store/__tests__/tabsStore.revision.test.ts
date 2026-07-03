import { describe, it, expect, beforeEach } from "vitest";
import { useTabsStore, type Tab } from "../tabsStore";

/**
 * Revision coherence (§7 / §16 #5): a stale-revision compile result must never
 * overwrite a newer preview. The frontend bumps `revision` optimistically on
 * every edit, and `setPages`/`setStatus` discard events whose revision is
 * strictly older than the tab's current revision.
 */
function freshTab(overrides: Partial<Tab> = {}): Tab {
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

describe("tabsStore revision guard (§7)", () => {
  beforeEach(() => {
    // Reset the store to a known single-tab state before each test.
    useTabsStore.setState({ tabs: [freshTab()], activeId: "tab-1" });
  });

  it("bumps revision on each distinct edit", () => {
    const store = useTabsStore.getState();
    store.updateContent("tab-1", "a");
    store.updateContent("tab-1", "b");
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.revision).toBe(2);
    expect(tab.content).toBe("b");
    expect(tab.dirty).toBe(true);
  });

  it("does not bump revision when content is unchanged", () => {
    const store = useTabsStore.getState();
    store.updateContent("tab-1", "old"); // same as initial content
    expect(useTabsStore.getState().tabs[0].revision).toBe(0);
  });

  it("applies a compiled event matching the current revision", () => {
    useTabsStore.setState({
      tabs: [freshTab({ revision: 3 })],
    });
    useTabsStore
      .getState()
      .setPages("tab-1", 3, ["<svg p3/>"], []);
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.svgPages).toEqual(["<svg p3/>"]);
  });

  it("discards a compiled event with a strictly older revision", () => {
    // The user already edited past revision 3 (now at 5); a late-arriving
    // compile tagged revision 3 must NOT clobber the current preview.
    useTabsStore.setState({
      tabs: [freshTab({ revision: 5, svgPages: ["<svg current/>"] })],
    });
    useTabsStore
      .getState()
      .setPages("tab-1", 3, ["<svg stale/>"], []);
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.svgPages).toEqual(["<svg current/>"]);
  });

  it("discards a status event with a strictly older revision", () => {
    useTabsStore.setState({
      tabs: [freshTab({ revision: 5, status: "success" })],
    });
    useTabsStore
      .getState()
      .setStatus("tab-1", 3, "error");
    expect(useTabsStore.getState().tabs[0].status).toBe("success");
  });

  it("applies a status event matching the current revision", () => {
    useTabsStore.setState({
      tabs: [freshTab({ revision: 4, status: "compiling" })],
    });
    useTabsStore
      .getState()
      .setStatus("tab-1", 4, "success", 42);
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.status).toBe("success");
    expect(tab.durationMs).toBe(42);
  });

  it("ignores events for unknown tabs without throwing", () => {
    expect(() =>
      useTabsStore.getState().setPages("nope", 1, ["<svg/>"], []),
    ).not.toThrow();
    expect(() =>
      useTabsStore.getState().setStatus("nope", 1, "success"),
    ).not.toThrow();
  });
});

describe("tabsStore conflict state (§8.4)", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [freshTab()], activeId: "tab-1" });
  });

  it("setConflict updates the conflict state", () => {
    useTabsStore.setState({ tabs: [freshTab({ conflict: "none" })] });
    useTabsStore.getState().setConflict("tab-1", "modified");
    expect(useTabsStore.getState().tabs[0].conflict).toBe("modified");
    useTabsStore.getState().setConflict("tab-1", "missing");
    expect(useTabsStore.getState().tabs[0].conflict).toBe("missing");
  });

  it("setConflict is a no-op for unknown tabs", () => {
    expect(() =>
      useTabsStore.getState().setConflict("nope", "modified"),
    ).not.toThrow();
  });

  it("updateContent resets conflict to none (user is editing past it)", () => {
    useTabsStore.setState({ tabs: [freshTab({ conflict: "modified", content: "a" })] });
    useTabsStore.getState().updateContent("tab-1", "b");
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.conflict).toBe("none");
    expect(tab.content).toBe("b");
  });

  it("updateContent does not change conflict when content is unchanged", () => {
    useTabsStore.setState({ tabs: [freshTab({ conflict: "modified", content: "same" })] });
    useTabsStore.getState().updateContent("tab-1", "same");
    expect(useTabsStore.getState().tabs[0].conflict).toBe("modified");
  });

  it("markSaved clears the conflict (save resolves it)", () => {
    useTabsStore.setState({
      tabs: [freshTab({ conflict: "missing", dirty: true, content: "x" })],
    });
    useTabsStore.getState().markSaved("tab-1", "/x/main.typ");
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.conflict).toBe("none");
    expect(tab.dirty).toBe(false);
  });
});
