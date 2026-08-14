import { describe, expect, it } from "vitest";
import {
  isSidebarViewVisible,
  shouldMountSidebarView,
  shouldShowEmptyWorkspace,
} from "../Sidebar";

describe("Sidebar visibility gates", () => {
  it("shows an active always-view without a workspace and does not cover it", () => {
    const outline = { id: "workbench.outline", when: "always" as const };

    expect(isSidebarViewVisible(outline, outline.id, null)).toBe(true);
    expect(shouldShowEmptyWorkspace(outline, null)).toBe(false);
  });

  it("keeps workspace-only views hidden behind the empty-workspace prompt", () => {
    const explorer = { id: "workbench.explorer", when: "workspace" as const };

    expect(isSidebarViewVisible(explorer, explorer.id, null)).toBe(false);
    expect(shouldShowEmptyWorkspace(explorer, null)).toBe(true);
  });

  it("preloads every eligible view regardless of active/visited state", () => {
    const outline = { id: "workbench.outline", when: "always" as const };
    const search = { id: "workbench.search", when: "workspace" as const };
    const explorer = { id: "workbench.explorer", when: "workspace" as const };

    // With a workspace open, all views mount eagerly — preloaded up front,
    // not gated behind activation or prior visits.
    expect(shouldMountSidebarView(outline, "/workspace")).toBe(true);
    expect(shouldMountSidebarView(search, "/workspace")).toBe(true);
    expect(shouldMountSidebarView(explorer, "/workspace")).toBe(true);
  });

  it("preloads always-views even without a workspace", () => {
    const outline = { id: "workbench.outline", when: "always" as const };
    expect(shouldMountSidebarView(outline, null)).toBe(true);
  });

  it("does not mount a workspace-only view before a workspace exists", () => {
    const search = { id: "workbench.search", when: "workspace" as const };
    expect(shouldMountSidebarView(search, null)).toBe(false);
  });
});
