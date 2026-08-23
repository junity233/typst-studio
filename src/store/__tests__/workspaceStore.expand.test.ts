import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "../workspaceStore";

/**
 * Regression pin (P1 concurrency sweep): `toggleExpand` used to snapshot the
 * `expanded` Set BEFORE an `await` and commit the stale copy afterwards, so
 * two fast successive toggles (or a `collapseAll` racing an in-flight expand)
 * each committed their pre-await copy and the first toggle's effect was
 * silently reverted. The fix commits through functional `set`, so every write
 * applies to the freshest state.
 *
 * Mocked: the IPC layer — the store runs without a live Tauri runtime.
 */
vi.mock("../../lib/tauri", () => ({
  deleteEntry: vi.fn(),
  deleteEntryPermanent: vi.fn(),
  readDir: vi.fn(() => {
    // Resolve on a later microtask/macrotask so the await window is real.
    return new Promise((resolve) => setTimeout(() => resolve([]), 5));
  }),
  closeWorkspace: vi.fn(),
  copyEntry: vi.fn(),
  createEntry: vi.fn(),
  getWorkspace: vi.fn(),
  openDefaultWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
  openWorkspaceByPath: vi.fn(),
  renameEntry: vi.fn(),
}));

function seedOpen(rootPath: string | null) {
  useWorkspaceStore.setState({
    rootPath,
    name: rootPath === null ? null : "ws",
    tree: {},
    expanded: new Set<string>(),
    loading: false,
  });
}

describe("workspaceStore.toggleExpand lost-update regression", () => {
  beforeEach(() => {
    seedOpen("/ws");
  });

  it("keeps both directories expanded when two toggles race", async () => {
    const { toggleExpand } = useWorkspaceStore.getState();
    // Start A's toggle (its ensureLoaded awaits ~5ms) but don't await it yet.
    const a = toggleExpand("a");
    // B's toggle starts while A is still inside its await.
    const b = toggleExpand("b");
    await Promise.all([a, b]);
    const expanded = useWorkspaceStore.getState().expanded;
    expect(expanded.has("a")).toBe(true);
    expect(expanded.has("b")).toBe(true);
  });

  it("collapseAll wins over an in-flight toggle (no zombie re-expansion)", async () => {
    const { toggleExpand, collapseAll } = useWorkspaceStore.getState();
    const inflight = toggleExpand("a");
    collapseAll();
    await inflight;
    expect(useWorkspaceStore.getState().expanded.has("a")).toBe(false);
  });

  it("collapse removes the entry functionally", async () => {
    const { toggleExpand } = useWorkspaceStore.getState();
    await toggleExpand("a");
    expect(useWorkspaceStore.getState().expanded.has("a")).toBe(true);
    await toggleExpand("a");
    expect(useWorkspaceStore.getState().expanded.has("a")).toBe(false);
  });
});

describe("workspaceStore.toggleExpand with no workspace", () => {
  it("does not throw when closed (expand state still flips, load is a no-op)", async () => {
    seedOpen(null);
    const { toggleExpand } = useWorkspaceStore.getState();
    await expect(toggleExpand("a")).resolves.toBeUndefined();
    // The Set flip itself is local UI state; only the child LOAD requires an
    // open workspace (refresh early-returns on rootPath === null).
    expect(useWorkspaceStore.getState().expanded.has("a")).toBe(true);
    expect(useWorkspaceStore.getState().tree["a"]).toBeUndefined();
  });
});
