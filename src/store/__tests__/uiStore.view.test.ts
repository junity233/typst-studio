import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../uiStore";

describe("uiStore activeViewId", () => {
  beforeEach(() => {
    useUiStore.getState().setActiveView(null);
    useUiStore.getState().setSidebar(true);
  });

  it("setActiveView sets the active view id and shows sidebar", () => {
    useUiStore.getState().setSidebar(false);
    useUiStore.getState().setActiveView("workbench.search");
    expect(useUiStore.getState().activeViewId).toBe("workbench.search");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("toggleView on inactive view activates it and shows sidebar", () => {
    useUiStore.getState().setActiveView("workbench.explorer");
    useUiStore.getState().toggleView("workbench.search");
    expect(useUiStore.getState().activeViewId).toBe("workbench.search");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("toggleView on already-active view hides sidebar", () => {
    useUiStore.getState().setActiveView("workbench.explorer");
    useUiStore.getState().setSidebar(true);
    useUiStore.getState().toggleView("workbench.explorer");
    expect(useUiStore.getState().sidebarVisible).toBe(false);
  });

  it("toggleView on inactive view when sidebar is hidden shows sidebar", () => {
    useUiStore.getState().setActiveView("workbench.explorer");
    useUiStore.getState().setSidebar(false);
    useUiStore.getState().toggleView("workbench.search");
    expect(useUiStore.getState().activeViewId).toBe("workbench.search");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });
});
