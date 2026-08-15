import { describe, it, expect } from "vitest";
import { commandRegistry } from "../registry";
import { useTabsStore } from "../../store/tabsStore";

// Importing the workbench extension module + calling ensureActivated() runs the
// same activate() path that dispatch() and App.tsx (via activateAll()) use.
import { ensureActivated } from "../workbench";

ensureActivated();

describe("workbench commands registered", () => {
  // Note: activate runs once at module load; these tests verify the result.

  it("registers all expected command ids", () => {
    const ids = commandRegistry.all().map((c) => c.id);
    expect(ids).toContain("new-tab");
    expect(ids).toContain("open-file");
    expect(ids).toContain("open-folder");
    expect(ids).toContain("save");
    expect(ids).toContain("save-as");
    expect(ids).toContain("close-tab");
    expect(ids).toContain("toggle-sidebar");
    expect(ids).toContain("toggle-preview");
    expect(ids).toContain("open-settings");
    expect(ids).toContain("export-pdf");
    expect(ids).toContain("export-png");
    expect(ids).toContain("export-svg");
  });

  it("every command has a non-empty title", () => {
    for (const c of commandRegistry.all()) {
      expect(c.title, `command ${c.id}`).toBeTruthy();
      expect(typeof c.title).toBe("string");
    }
  });

  it("file/export commands declare a keybinding", () => {
    const withKb = [
      "new-tab",
      "open-file",
      "save",
      "save-as",
      "close-tab",
      "toggle-sidebar",
      "toggle-preview",
    ];
    for (const id of withKb) {
      const cmd = commandRegistry.get(id);
      expect(cmd?.keybinding, `command ${id}`).toBeTruthy();
    }
  });

  // open-folder deliberately has NO keybinding: its old Shift+O collided with
  // Show Outline, and muda (Tauri's menu lib) can't express the VS Code-style
  // Ctrl+K Ctrl+O chord. Reachable via the File menu + welcome screen instead.
  it("open-folder has no keybinding (collision-avoidance)", () => {
    const cmd = commandRegistry.get("open-folder");
    expect(cmd?.keybinding).toBeUndefined();
  });

  // The active-tab commands share one enablement predicate (hasActiveTab) that
  // reads live state — pins the wiring, not just the registration.
  it("active-tab commands' enablement tracks the live tab state", () => {
    const gated = ["save", "save-as", "close-tab", "export", "export-pdf", "export-png", "export-svg"];
    const prev = useTabsStore.getState().activeId;
    try {
      useTabsStore.setState({ activeId: null });
      for (const id of gated) {
        expect(commandRegistry.get(id)?.enablement?.(), `command ${id}`).toBe(false);
      }
      useTabsStore.setState({ activeId: "test-doc" });
      for (const id of gated) {
        expect(commandRegistry.get(id)?.enablement?.(), `command ${id}`).toBe(true);
      }
    } finally {
      useTabsStore.setState({ activeId: prev });
    }
  });
});
