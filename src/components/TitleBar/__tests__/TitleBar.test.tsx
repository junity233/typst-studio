import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../../Sidebar/contextMenuStore";

/**
 * Pins the Open Recent dispatch contract: the File menu's recent entries must
 * dispatch `open-recent:<encodeURIComponent(path)>` — the SAME path shown in
 * the label — never an index. (Indices drift against the freshly-loaded
 * move-to-front list the dispatcher in useAppCommands resolves against, so an
 * index-based id can open the WRONG workspace.)
 */

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  loadSession: vi.fn(),
}));

vi.mock("../../../hooks/useAppCommands", () => ({
  dispatch: mocks.dispatch,
}));

vi.mock("../../../lib/session", () => ({
  loadSession: mocks.loadSession,
}));

// The component module primes `recentCache` at import time via loadSession.
mocks.loadSession.mockResolvedValue({
  recentWorkspaces: ["C:\\ws\\alpha", "C:\\ws\\beta"],
});

const { buildFileMenu } = await import("../TitleBar");

const t = (key: string): string => key;

function recentChildren(menu: MenuItem[]): MenuItem[] {
  const submenu = menu.find(
    (m) => m.type === "submenu" && m.label === "openRecent",
  );
  if (submenu === undefined || submenu.type !== "submenu") {
    throw new Error("openRecent submenu not found");
  }
  return submenu.children;
}

describe("buildFileMenu — Open Recent dispatch ids", () => {
  beforeEach(() => {
    mocks.dispatch.mockClear();
  });

  it("dispatches path-encoded ids for each cached recent entry", () => {
    const children = recentChildren(buildFileMenu(t));
    expect(children).toHaveLength(2);

    children.forEach((item) => {
      expect(item.type).toBe("action");
      if (item.type === "action") item.onSelect();
    });

    expect(mocks.dispatch.mock.calls.map((c) => c[0])).toEqual([
      "open-recent:C%3A%5Cws%5Calpha",
      "open-recent:C%3A%5Cws%5Cbeta",
    ]);
  });

  it("labels each entry with the workspace basename", () => {
    const children = recentChildren(buildFileMenu(t));
    const labels = children.map((c) => (c.type === "action" ? c.label : ""));
    expect(labels).toEqual(["alpha", "beta"]);
  });
});
