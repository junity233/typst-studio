import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Batch-close orchestration (`closeOtherTabs` / `closeTabsToTheRight` /
 * `closeAllTabs` / `closeSavedTabs`) built on top of `closeTabWithConfirm`.
 *
 * Key behaviors under test:
 *   - clean tabs close immediately (soft-close, no prompt);
 *   - a dirty-tab prompt that the user CANCELS short-circuits the loop and
 *     leaves the remaining tabs open (the returned promise rejects to `false`);
 *   - `closeSavedTabs` skips dirty tabs entirely (no prompt, no close);
 *   - `closeOtherTabs` / `closeTabsToTheRight` keep the anchor tab open.
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const {
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTabsToTheRight,
} = await import("../commands");
const { useDocumentsStore } = await import("../../store/documentsStore");
const { useDialogStore } = await import("../../store/dialogStore");
const { useTabsStore } = await import("../../store/tabsStore");

/** Seed a minimal document with the given dirty flag. */
function seedDoc(id: string, dirty: boolean) {
  useDocumentsStore.getState().upsertDocument({
    id,
    title: `${id}.typ`,
    path: `/w/${id}.typ`,
    dirty,
    content: "x",
    origin: { kind: "looseFile", path: `/w/${id}.typ`, root: "/w" },
    revision: 0,
    compiledRevision: 0,
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
  });
}

function reset() {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useDialogStore.getState().resolve("cancel");
  useDocumentsStore.getState().documents = {};
  useTabsStore.setState({ tabs: [], activeId: null, hidden: [] });
}

describe("closeOtherTabs / closeTabsToTheRight / closeAllTabs / closeSavedTabs", () => {
  beforeEach(reset);

  it("closeOtherTabs closes every other clean tab and keeps the anchor", async () => {
    for (const id of ["a", "b", "c"]) seedDoc(id, false);
    useTabsStore.setState({ tabs: ["a", "b", "c"], activeId: "b" });

    const ok = await closeOtherTabs("b");
    expect(ok).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual(["b"]);
  });

  it("a cancelled dirty-tab prompt stops the loop and leaves remaining tabs", async () => {
    seedDoc("b", true); // dirty — prompts; user cancels (first in order)
    seedDoc("c", false); // would-be-next, but the loop must stop at b
    useTabsStore.setState({ tabs: ["b", "c"], activeId: "b" });

    // Drive the close; the first dirty prompt (b) is resolved as "cancel".
    // 'b' is first in the tab list so its prompt opens before any close races.
    const p = closeAllTabs();
    // Resolve once 'b's dialog is open. The close loop awaits its prompt
    // synchronously after reaching 'b', so resolving here unblocks it.
    useDialogStore.getState().resolve("cancel");
    const ok = await p;

    expect(ok).toBe(false);
    // 'b' and 'c' both survived the cancel (nothing was closed).
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toContain("b");
    expect(tabs).toContain("c");
  });

  it("closeTabsToTheRight only closes tabs after the anchor", async () => {
    for (const id of ["a", "b", "c", "d"]) seedDoc(id, false);
    useTabsStore.setState({ tabs: ["a", "b", "c", "d"], activeId: "b" });

    const ok = await closeTabsToTheRight("b");
    expect(ok).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual(["a", "b"]);
  });

  it("closeTabsToTheRight on the last tab is a no-op and returns true", async () => {
    seedDoc("only", false);
    useTabsStore.setState({ tabs: ["only"], activeId: "only" });
    const ok = await closeTabsToTheRight("only");
    expect(ok).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual(["only"]);
  });

  it("closeSavedTabs closes only clean tabs and skips dirty ones (no prompt)", async () => {
    seedDoc("clean1", false);
    seedDoc("dirty1", true);
    seedDoc("clean2", false);
    useTabsStore.setState({ tabs: ["clean1", "dirty1", "clean2"], activeId: "clean1" });

    const closed = await closeSavedTabs();
    expect(closed.sort()).toEqual(["clean1", "clean2"]);
    // The dirty tab is untouched (no prompt was shown for it).
    expect(useTabsStore.getState().tabs).toEqual(["dirty1"]);
    // No save/discard dialog commands should have run for the skipped dirty tab.
    const cmds = invokeMock.mock.calls.map(([c]) => c as string);
    expect(cmds).not.toContain("discard_recovery");
  });
});
