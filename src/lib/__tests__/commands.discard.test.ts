import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * §5.1.4: the close-confirm "Don't Save" path must call `discard_recovery` for
 * the document before closing it, so the explicitly-discarded content is NOT
 * offered for recovery on the next launch.
 *
 * `closeTabWithConfirm` reads from `documentsStore` + `dialogStore` + calls the
 * backend via `tauri`. We mock `@tauri-apps/api/core`'s `invoke` and drive the
 * real `dialogStore` + `documentsStore` + `tabsStore` so the full decision flow
 * is exercised.
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const { closeTabWithConfirm } = await import("../commands");
const { useDocumentsStore } = await import("../../store/documentsStore");
const { useDialogStore } = await import("../../store/dialogStore");
const { useTabsStore } = await import("../../store/tabsStore");

function reset() {
  invokeMock.mockReset();
  // Most backend calls resolve void/empty; closeTab resolves void.
  invokeMock.mockResolvedValue(undefined);
  useDialogStore.getState().resolve("cancel"); // clear any pending
}

describe("closeTabWithConfirm 'Don't Save' calls discard_recovery (§5.1.4)", () => {
  beforeEach(() => {
    reset();
    // Start each test with a clean documents map + empty tabs.
    useDocumentsStore.getState().documents = {};
    useTabsStore.setState({ tabs: [], activeId: null });
  });

  it("dirty tab + 'Don't Save' → discard_recovery then close", async () => {
    // Seed a dirty document in the store.
    useDocumentsStore.getState().upsertDocument({
      id: "doc-x",
      title: "notes.typ",
      path: "/w/notes.typ",
      dirty: true,
      content: "unsaved edits",
      revision: 3,
      conflict: "none",
      status: "idle",
      durationMs: null,
      svgPages: [],
      lineMap: [],
    });
    useTabsStore.setState({ tabs: ["doc-x"], activeId: "doc-x" });

    // Kick off the close (returns a promise awaiting the dialog).
    const closing = closeTabWithConfirm("doc-x");
    // Resolve the dialog as "discard" (Don't Save).
    useDialogStore.getState().resolve("discard");
    const closed = await closing;

    expect(closed).toBe(true);
    // discard_recovery was invoked with the doc id.
    const calls = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    expect(calls).toContain("discard_recovery");
    const discardArgs = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "discard_recovery",
    )?.[1];
    expect(discardArgs).toEqual({ id: "doc-x" });
    // close_tab was also invoked (the backend close).
    expect(calls).toContain("close_tab");
  });

  it("dirty tab + 'Save' → does NOT discard recovery", async () => {
    useDocumentsStore.getState().upsertDocument({
      id: "doc-y",
      title: "saved.typ",
      path: "/w/saved.typ",
      dirty: true,
      content: "x",
      revision: 1,
      conflict: "none",
      status: "idle",
      durationMs: null,
      svgPages: [],
      lineMap: [],
    });
    useTabsStore.setState({ tabs: ["doc-y"], activeId: "doc-y" });

    const closing = closeTabWithConfirm("doc-y");
    useDialogStore.getState().resolve("confirm"); // Save
    await closing;

    const calls = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    expect(calls).not.toContain("discard_recovery");
    // Save path must not discard recovery; save_file or save_as is invoked instead.
    expect(calls.some((c) => c === "save_file" || c === "save_as")).toBe(true);
  });

  it("clean tab → no prompt, no discard_recovery", async () => {
    useDocumentsStore.getState().upsertDocument({
      id: "doc-clean",
      title: "clean.typ",
      path: "/w/clean.typ",
      dirty: false,
      content: "x",
      revision: 0,
      conflict: "none",
      status: "idle",
      durationMs: null,
      svgPages: [],
      lineMap: [],
    });
    useTabsStore.setState({ tabs: ["doc-clean"], activeId: "doc-clean" });

    const closed = await closeTabWithConfirm("doc-clean");
    expect(closed).toBe(true);
    const calls = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    // Clean close must not discard recovery (nothing was discarded).
    expect(calls).not.toContain("discard_recovery");
  });

  it("dirty tab + 'Cancel' → no close, no discard", async () => {
    useDocumentsStore.getState().upsertDocument({
      id: "doc-cancel",
      title: "x.typ",
      path: null,
      dirty: true,
      content: "x",
      revision: 1,
      conflict: "none",
      status: "idle",
      durationMs: null,
      svgPages: [],
      lineMap: [],
    });
    useTabsStore.setState({ tabs: ["doc-cancel"], activeId: "doc-cancel" });

    const closing = closeTabWithConfirm("doc-cancel");
    useDialogStore.getState().resolve("cancel");
    const closed = await closing;
    expect(closed).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
