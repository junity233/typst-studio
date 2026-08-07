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
});
