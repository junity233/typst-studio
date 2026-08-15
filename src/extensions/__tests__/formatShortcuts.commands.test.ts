import { describe, it, expect } from "vitest";
import { commandRegistry } from "../registry";
import { createHostApi } from "../api";
// Importing the extension module + calling activate() runs the same path
// activateAll() uses at app start.
import activate from "../formatShortcuts";

/**
 * Pins the formatShortcuts command surface: the seven ids, their default
 * keybindings, and the enablement gate (a formatting keystroke must no-op with
 * no active tab — it would otherwise hit a null editor api).
 */

activate(createHostApi("formatShortcuts"));

describe("formatShortcuts commands registered", () => {
  it("registers the seven format commands with their default keybindings", () => {
    const expected: Record<string, string> = {
      "format.bold": "Ctrl+B",
      "format.italic": "Ctrl+I",
      "format.strikethrough": "Ctrl+Shift+X",
      "format.code": "Ctrl+`",
      "format.heading1": "Ctrl+1",
      "format.heading2": "Ctrl+2",
      "format.heading3": "Ctrl+3",
    };
    for (const [id, keybinding] of Object.entries(expected)) {
      const cmd = commandRegistry.get(id);
      expect(cmd, `command ${id}`).toBeDefined();
      expect(cmd?.keybinding, `keybinding of ${id}`).toBe(keybinding);
      expect(cmd?.title, `title of ${id}`).toBeTruthy();
    }
  });

  it("handlers no-op without an active tab and without a live editor", () => {
    for (const cmd of commandRegistry.all()) {
      if (!cmd.id.startsWith("format.")) continue;
      expect(cmd.enablement?.(undefined as never)).toBe(false);
      // Even if enablement is bypassed, a null editorApiRef must not throw.
      expect(() => cmd.handler(undefined as never)).not.toThrow();
    }
  });
});
