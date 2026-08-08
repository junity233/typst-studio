import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the platform so matchKeybinding/formatKeybinding are deterministic. The
// module reads `isMac` at load time, so the mock must be in place before the
// module under test imports it — vi.mock factories are hoisted, which handles
// the ordering. We flip the value per-suite via the mutable `platform` handle.
let platform = { isMac: false, isWindows: false };
vi.mock("../../lib/platform", () => ({
  get isMac() {
    return platform.isMac;
  },
  get isWindows() {
    return platform.isWindows;
  },
}));

import {
  parseKeybinding,
  matchKeybinding,
  formatKeybinding,
  captureKeybinding,
  keybindingsEqual,
} from "../keybinding";

/** Build a minimal KeyboardEvent-like object for matcher tests. */
function ev(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  } as KeyboardEvent;
}

describe("parseKeybinding", () => {
  it("parses a single modifier + letter", () => {
    const p = parseKeybinding("Ctrl+B");
    expect(p).toEqual({
      cmdOrCtrl: false,
      ctrl: true,
      cmd: false,
      shift: false,
      alt: false,
      key: "b",
    });
  });

  it("parses multiple modifiers + key", () => {
    const p = parseKeybinding("CmdOrCtrl+Shift+P");
    expect(p).toMatchObject({ cmdOrCtrl: true, shift: true, ctrl: false, key: "p" });
  });

  it("parses Shift+Alt+F (modifier order in string is irrelevant)", () => {
    const p = parseKeybinding("Shift+Alt+F");
    expect(p).toMatchObject({ shift: true, alt: true, cmdOrCtrl: false, key: "f" });
  });

  it("parses a punctuation main key", () => {
    expect(parseKeybinding("CmdOrCtrl+,")?.key).toBe(",");
  });

  it("parses a backtick main key", () => {
    expect(parseKeybinding("Ctrl+`")?.key).toBe("`");
  });

  it("parses a digit main key", () => {
    expect(parseKeybinding("Ctrl+1")?.key).toBe("1");
  });

  it("parses a backslash main key", () => {
    expect(parseKeybinding("CmdOrCtrl+\\")?.key).toBe("\\");
  });

  it("lower-cases letter keys (case-insensitive tokens)", () => {
    expect(parseKeybinding("SHIFT+S")?.key).toBe("s");
    expect(parseKeybinding("shift+s")?.shift).toBe(true);
  });

  it("trims whitespace around parts", () => {
    expect(parseKeybinding("  Ctrl + B  ")?.key).toBe("b");
  });

  it("returns null for empty string (disabled)", () => {
    expect(parseKeybinding("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseKeybinding("   ")).toBeNull();
  });

  it("returns null when no main key is present (bare modifiers)", () => {
    expect(parseKeybinding("Ctrl+Shift")).toBeNull();
    expect(parseKeybinding("Ctrl")).toBeNull();
  });

  it("returns null for a second main key (malformed)", () => {
    expect(parseKeybinding("Ctrl+A+B")).toBeNull();
  });

  it("tolerates a dangling separator (empty parts are skipped)", () => {
    // The parser trims empty parts for whitespace tolerance; capture-based
    // input never produces these, so this is purely a robustness behavior.
    expect(parseKeybinding("Ctrl++B")?.key).toBe("b");
    expect(parseKeybinding("+B")?.key).toBe("b");
  });

  it("returns null for a multi-char junk key", () => {
    expect(parseKeybinding("Ctrl+Junk")).toBeNull();
  });

  it("parses named special keys to stable tokens", () => {
    // Spellings a user might type OR that the browser's e.key reports both
    // collapse to the same token, so authored and captured forms match.
    expect(parseKeybinding("Ctrl+Enter")?.key).toBe("enter");
    expect(parseKeybinding("Ctrl+Return")?.key).toBe("enter");
    expect(parseKeybinding("Ctrl+Tab")?.key).toBe("tab");
    expect(parseKeybinding("Ctrl+Escape")?.key).toBe("escape");
    expect(parseKeybinding("Ctrl+Esc")?.key).toBe("escape");
    expect(parseKeybinding("Ctrl+Space")?.key).toBe("space");
    expect(parseKeybinding("Ctrl+Backspace")?.key).toBe("backspace");
    expect(parseKeybinding("Ctrl+Delete")?.key).toBe("delete");
    expect(parseKeybinding("Ctrl+Home")?.key).toBe("home");
    expect(parseKeybinding("Ctrl+End")?.key).toBe("end");
    expect(parseKeybinding("Ctrl+PageUp")?.key).toBe("pageup");
    expect(parseKeybinding("Ctrl+PageDown")?.key).toBe("pagedown");
  });

  it("parses arrow keys from both the alias and the e.key spelling", () => {
    expect(parseKeybinding("Ctrl+Up")?.key).toBe("up");
    expect(parseKeybinding("Ctrl+ArrowUp")?.key).toBe("up");
    expect(parseKeybinding("Ctrl+ArrowLeft")?.key).toBe("left");
    expect(parseKeybinding("Ctrl+Right")?.key).toBe("right");
  });

  it("parses function keys F1–F24", () => {
    expect(parseKeybinding("Ctrl+F1")?.key).toBe("f1");
    expect(parseKeybinding("Ctrl+F12")?.key).toBe("f12");
    expect(parseKeybinding("Ctrl+F24")?.key).toBe("f24");
    // Out of range / not a function key.
    expect(parseKeybinding("Ctrl+F0")).toBeNull();
    expect(parseKeybinding("Ctrl+F25")).toBeNull();
    expect(parseKeybinding("Ctrl+F")).not.toBeNull(); // plain letter F still ok
  });

  it("parses tokens case-insensitively (Enter ≡ enter ≡ ENTER)", () => {
    expect(parseKeybinding("Ctrl+ENTER")?.key).toBe("enter");
    expect(parseKeybinding("Ctrl+SHIFT+F1")?.key).toBe("f1");
  });
});

describe("matchKeybinding", () => {
  beforeEach(() => {
    platform.isMac = false;
  });

  it("matches the exact binding (non-mac CmdOrCtrl = ctrl)", () => {
    const p = parseKeybinding("CmdOrCtrl+S")!;
    expect(matchKeybinding(p, ev("s", { ctrl: true }))).toBe(true);
  });

  it("rejects when an extra modifier is held", () => {
    const p = parseKeybinding("CmdOrCtrl+S")!;
    expect(matchKeybinding(p, ev("s", { ctrl: true, shift: true }))).toBe(false);
  });

  it("rejects when a required modifier is missing", () => {
    const p = parseKeybinding("CmdOrCtrl+Shift+S")!;
    expect(matchKeybinding(p, ev("s", { ctrl: true }))).toBe(false);
  });

  it("Ctrl+Shift+S does NOT match Ctrl+S", () => {
    const shiftBinding = parseKeybinding("CmdOrCtrl+Shift+S")!;
    expect(matchKeybinding(shiftBinding, ev("s", { ctrl: true }))).toBe(false);
  });

  it("Shift+Alt+F matches only without a meta key (distinct from Ctrl+Shift+F)", () => {
    const p = parseKeybinding("Shift+Alt+F")!;
    expect(matchKeybinding(p, ev("F", { shift: true, alt: true }))).toBe(true);
    expect(matchKeybinding(p, ev("f", { ctrl: true, shift: true, alt: true }))).toBe(false);
  });

  it("on mac, CmdOrCtrl matches metaKey not ctrlKey", () => {
    platform.isMac = true;
    const p = parseKeybinding("CmdOrCtrl+B")!;
    expect(matchKeybinding(p, ev("b", { meta: true }))).toBe(true);
    expect(matchKeybinding(p, ev("b", { ctrl: true }))).toBe(false);
    // both held is also a miss (must be exactly the accelerator)
    expect(matchKeybinding(p, ev("b", { meta: true, ctrl: true }))).toBe(false);
  });

  it("plain Ctrl binding matches ctrlKey regardless of platform", () => {
    platform.isMac = true;
    const p = parseKeybinding("Ctrl+B")!;
    expect(matchKeybinding(p, ev("b", { ctrl: true }))).toBe(true);
  });

  it("matches named keys via the event's e.key spelling", () => {
    // The binding stores the token ("enter"/"f5"/"left"/"space"); the event
    // carries the browser's e.key ("Enter"/"F5"/"ArrowLeft"/" "). Matching
    // must normalize both sides so a captured binding fires on the right key.
    const enter = parseKeybinding("Ctrl+Enter")!;
    expect(matchKeybinding(enter, ev("Enter", { ctrl: true }))).toBe(true);
    expect(matchKeybinding(enter, ev("Return", { ctrl: true }))).toBe(true);
    expect(matchKeybinding(enter, ev("b", { ctrl: true }))).toBe(false);

    const f5 = parseKeybinding("Ctrl+F5")!;
    expect(matchKeybinding(f5, ev("F5", { ctrl: true }))).toBe(true);

    const left = parseKeybinding("Ctrl+ArrowLeft")!;
    expect(matchKeybinding(left, ev("ArrowLeft", { ctrl: true }))).toBe(true);

    const space = parseKeybinding("Ctrl+Space")!;
    // A Space keydown reports e.key === " ".
    expect(matchKeybinding(space, ev(" ", { ctrl: true }))).toBe(true);
    expect(matchKeybinding(space, ev("space", { ctrl: true }))).toBe(true);
  });
});

describe("formatKeybinding", () => {
  afterEach(() => {
    platform.isMac = false;
  });

  it("renders word + plus form on non-mac", () => {
    platform.isMac = false;
    expect(formatKeybinding("CmdOrCtrl+Shift+B")).toBe("Ctrl+Shift+B");
  });

  it("renders glyph form on mac", () => {
    platform.isMac = true;
    expect(formatKeybinding("CmdOrCtrl+Shift+B")).toBe("⌘⇧B");
    expect(formatKeybinding("CmdOrCtrl+B")).toBe("⌘B");
  });

  it("upper-cases single-letter keys in display", () => {
    platform.isMac = false;
    expect(formatKeybinding("Ctrl+b")).toBe("Ctrl+B");
  });

  it("returns the input verbatim when unparseable", () => {
    expect(formatKeybinding("")).toBe("");
    expect(formatKeybinding("garbage")).toBe("garbage");
  });

  it("renders named special keys with friendly display names", () => {
    platform.isMac = false;
    expect(formatKeybinding("Ctrl+Enter")).toBe("Ctrl+Enter");
    expect(formatKeybinding("Ctrl+F5")).toBe("Ctrl+F5");
    expect(formatKeybinding("Ctrl+ArrowLeft")).toBe("Ctrl+←");
    expect(formatKeybinding("Ctrl+Space")).toBe("Ctrl+Space");
    expect(formatKeybinding("Shift+PageUp")).toBe("Shift+PageUp");
  });
});

describe("captureKeybinding", () => {
  it("serializes a full chord with CmdOrCtrl normalization", () => {
    expect(captureKeybinding(ev("b", { ctrl: true }))).toBe("CmdOrCtrl+b");
    expect(captureKeybinding(ev("b", { meta: true }))).toBe("CmdOrCtrl+b");
  });

  it("preserves Alt and Shift in canonical order", () => {
    expect(captureKeybinding(ev("b", { ctrl: true, alt: true, shift: true }))).toBe(
      "CmdOrCtrl+Alt+Shift+b",
    );
  });

  it("lower-cases the main key", () => {
    expect(captureKeybinding(ev("B", { ctrl: true }))).toBe("CmdOrCtrl+b");
  });

  it("returns null for a bare modifier press (waiting for the key)", () => {
    expect(captureKeybinding(ev("Control", { ctrl: true }))).toBeNull();
    expect(captureKeybinding(ev("Shift", { shift: true }))).toBeNull();
    expect(captureKeybinding(ev("Alt", { alt: true }))).toBeNull();
    expect(captureKeybinding(ev("Meta", { meta: true }))).toBeNull();
  });

  it("returns null for Escape (cancel)", () => {
    expect(captureKeybinding(ev("Escape"))).toBeNull();
  });

  it("serializes named/special keys to stable tokens (not raw e.key)", () => {
    // Regression: F-keys/arrows/Enter have multi-char e.key values; the old
    // implementation emitted them verbatim, producing unparseable, never-
    // matching, backend-rejected bindings. The captured string must now
    // round-trip through parseKeybinding.
    expect(captureKeybinding(ev("F1", { ctrl: true }))).toBe("CmdOrCtrl+f1");
    expect(captureKeybinding(ev("F12", { ctrl: true }))).toBe("CmdOrCtrl+f12");
    expect(captureKeybinding(ev("Enter", { ctrl: true }))).toBe("CmdOrCtrl+enter");
    expect(captureKeybinding(ev("ArrowLeft", { ctrl: true }))).toBe("CmdOrCtrl+left");
    expect(captureKeybinding(ev(" ", { ctrl: true }))).toBe("CmdOrCtrl+space");
    expect(captureKeybinding(ev("Tab", { ctrl: true }))).toBe("CmdOrCtrl+tab");
    // Each captured value parses back.
    for (const k of ["F1", "F12", "Enter", "ArrowLeft", "Tab"]) {
      const captured = captureKeybinding(ev(k, { ctrl: true }))!;
      expect(parseKeybinding(captured)).not.toBeNull();
    }
  });

  it("returns null for an unmappable key (keep listening)", () => {
    // Dead/Unidentified/IME-composing keys have no stable e.key — emitting one
    // would store a dead binding. Treat like a bare modifier: stay in listen.
    expect(captureKeybinding(ev("Dead"))).toBeNull();
    expect(captureKeybinding(ev("Unidentified"))).toBeNull();
    expect(captureKeybinding(ev("Process"))).toBeNull();
  });
});

describe("keybindingsEqual", () => {
  // Conflict detection relies on these: two bindings that match the SAME event
  // on this platform collide, even if their strings differ. The dispatcher
  // resolves collisions by registry order; surfacing them in the UI is the
  // user's only warning.
  it("treats CmdOrCtrl and Ctrl as equal off-mac", () => {
    platform.isMac = false;
    const a = parseKeybinding("CmdOrCtrl+B")!;
    const b = parseKeybinding("Ctrl+B")!;
    expect(keybindingsEqual(a, b)).toBe(true);
  });

  it("treats CmdOrCtrl and Cmd as equal on mac", () => {
    platform.isMac = true;
    const a = parseKeybinding("CmdOrCtrl+B")!;
    const b = parseKeybinding("Cmd+B")!;
    expect(keybindingsEqual(a, b)).toBe(true);
  });

  it("modifier order is irrelevant (Shift+Alt+F ≡ Alt+Shift+F)", () => {
    platform.isMac = false;
    const a = parseKeybinding("Shift+Alt+F")!;
    const b = parseKeybinding("Alt+Shift+F")!;
    expect(keybindingsEqual(a, b)).toBe(true);
  });

  it("distinguishes differing main keys and modifiers", () => {
    platform.isMac = false;
    expect(keybindingsEqual(parseKeybinding("Ctrl+B")!, parseKeybinding("Ctrl+I")!)).toBe(false);
    expect(keybindingsEqual(parseKeybinding("Ctrl+B")!, parseKeybinding("Ctrl+Shift+B")!)).toBe(false);
    expect(keybindingsEqual(parseKeybinding("Ctrl+B")!, parseKeybinding("Alt+B")!)).toBe(false);
  });

  it("CmdOrCtrl+B is distinct from plain Cmd+B off-mac", () => {
    // On Windows/Linux, CmdOrCtrl resolves to Ctrl; a plain Cmd modifier would
    // be the meta key, which is a different chord — not a collision.
    platform.isMac = false;
    const a = parseKeybinding("CmdOrCtrl+B")!;
    const b = parseKeybinding("Cmd+B")!;
    expect(keybindingsEqual(a, b)).toBe(false);
  });
});
