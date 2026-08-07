/**
 * Keybinding string parse / match / format / capture utilities.
 *
 * The app stores keybindings as VS Code / Tauri accelerator strings, e.g.
 * `"CmdOrCtrl+Shift+P"`, `"Ctrl+Alt+M"`, `"Shift+Alt+F"`, `"Ctrl+\\"`. These are
 * declarative metadata on `CommandContribution.keybinding` AND user-editable
 * values stored under `keybindings.*` settings. This module is the single place
 * that knows how to turn those strings into something a `keydown` listener can
 * match against, and back into a human-friendly display form.
 *
 * The grammar:
 *   binding   := part ("+" part)*
 *   part      := modifier | keyCode
 *   modifier  := "CmdOrCtrl" | "Ctrl" | "Cmd" | "Shift" | "Alt"
 *   keyCode   := a single Letter | Digit | Punctuation
 *
 * `CmdOrCtrl` is the cross-platform modifier: it maps to `metaKey` on macOS and
 * `ctrlKey` elsewhere (mirrors Tauri/muda and VS Code). Plain `Ctrl` / `Cmd`
 * always map to `ctrlKey` / `metaKey` respectively regardless of platform.
 *
 * A binding MUST have exactly one non-modifier part (the main key). A bare
 * `"Ctrl+Shift"` is invalid (no key to press) and parses to `null`. The empty
 * string also parses to `null` — by convention that means "this shortcut is
 * disabled", so callers treat `null` as "do not bind".
 */

import { isMac } from "../lib/platform";

/** The parsed shape of one keybinding string. */
export interface ParsedKeybinding {
  /** Cross-platform accelerator: metaKey on mac, ctrlKey elsewhere. */
  cmdOrCtrl: boolean;
  ctrl: boolean;
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  /** The main key, lowercased for letters; raw for digits/punctuation. */
  key: string;
}

/** Recognized modifier tokens (case-sensitive on input, but we lower-case). */
const MODIFIERS = new Set(["cmdorctrl", "ctrl", "cmd", "shift", "alt"]);

/**
 * Parse a keybinding string. Returns `null` for the empty string (disabled) or
 * any input that doesn't resolve to exactly one main key plus zero or more
 * modifiers. Whitespace around parts is trimmed, and tokens are matched
 * case-insensitively (`"shift"` ≡ `"Shift"` ≡ `"SHIFT"`).
 */
export function parseKeybinding(input: string): ParsedKeybinding | null {
  const raw = input?.trim();
  // Empty string = explicitly disabled. Callers should treat null as "no bind".
  if (raw === "") return null;

  const parts = raw.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const out: ParsedKeybinding = {
    cmdOrCtrl: false,
    ctrl: false,
    cmd: false,
    shift: false,
    alt: false,
    key: "",
  };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      switch (lower) {
        case "cmdorctrl": out.cmdOrCtrl = true; break;
        case "ctrl": out.ctrl = true; break;
        case "cmd": out.cmd = true; break;
        case "shift": out.shift = true; break;
        case "alt": out.alt = true; break;
      }
    } else {
      // First non-modifier token wins as the main key. A second non-modifier
      // token means the input is malformed (e.g. "Ctrl+A+B") — reject it.
      if (out.key !== "") return null;
      out.key = normalizeKey(part);
    }
  }

  // Must have exactly one main key.
  if (out.key === "") return null;
  return out;
}

/**
 * Normalize a main-key token: lower-case single letters, keep digits and
 * punctuation as-is. Single character only — a multi-char token that isn't a
 * known modifier is rejected upstream by parseKeybinding (returns null via the
 * "second non-modifier" rule only if it's the 2nd; a lone multi-char junk token
 * like "Foo" would slip through as key "foo", which is fine — it just won't
 * match any real event). We additionally reject obviously-bad multi-char keys
 * here so a typo in settings is caught.
 */
function normalizeKey(part: string): string {
  // Single char: letters lower-cased, digits/punct kept.
  if (part.length === 1) {
    return part.toLowerCase();
  }
  // Allow a few spelled-out special keys we care about. Currently none are
  // used (the app's keybindings are all single chars), but this is the seam
  // for future "Space" / "Enter" / "F1" support.
  const named: Record<string, string> = {
    space: " ",
    enter: "enter",
    escape: "escape",
    esc: "escape",
    tab: "tab",
  };
  const lower = part.toLowerCase();
  if (named[lower]) return named[lower];
  // Reject multi-char junk: a keybinding must be a concrete single key.
  return "";
}

/**
 * Does a real `keydown` event match a parsed binding? Compares all four
 * modifier flags plus the main key. `CmdOrCtrl` is satisfied by metaKey on mac
 * or ctrlKey elsewhere. Used by the global dispatcher in useAppCommands.
 */
export function matchKeybinding(
  p: ParsedKeybinding,
  e: KeyboardEvent,
): boolean {
  // Modifier flags must match exactly — an extra held modifier disqualifies.
  if (e.shiftKey !== p.shift) return false;
  if (e.altKey !== p.alt) return false;

  if (p.cmdOrCtrl) {
    // Exactly one of meta/ctrl must represent the accelerator on each platform.
    if (isMac) {
      if (!e.metaKey || e.ctrlKey) return false;
    } else {
      if (!e.ctrlKey || e.metaKey) return false;
    }
  } else {
    if (e.metaKey !== p.cmd) return false;
    if (e.ctrlKey !== p.ctrl) return false;
  }

  // Main key: compare case-insensitively. e.key for letters is already
  // case-sensitive to shift state ("a" vs "A"); we lower-case both sides.
  return e.key.toLowerCase() === p.key;
}

/**
 * Re-serialize a binding string to a human-friendly display form for the
 * settings UI and command palette. On macOS we render glyphs (⌘ ⇧ ⌥ ⌃); on
 * other platforms we render words joined by "+". Unknown / unparseable input
 * is returned verbatim so the user still sees what they typed.
 */
export function formatKeybinding(input: string): string {
  const p = parseKeybinding(input);
  if (p === null) return input;

  if (isMac) {
    const mods: string[] = [];
    if (p.cmdOrCtrl || p.cmd) mods.push("⌘");
    if (p.ctrl) mods.push("⌃");
    if (p.alt) mods.push("⌥");
    if (p.shift) mods.push("⇧");
    return mods.join("") + prettyKey(p.key);
  }
  const mods: string[] = [];
  if (p.cmdOrCtrl) mods.push("Ctrl");
  if (p.ctrl) mods.push("Ctrl");
  if (p.cmd) mods.push("Cmd");
  if (p.alt) mods.push("Alt");
  if (p.shift) mods.push("Shift");
  mods.push(prettyKey(p.key));
  return mods.join("+");
}

/** Render a main key for display: upper-case single letters (B), keep rest. */
function prettyKey(key: string): string {
  if (key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
  return key;
}

/**
 * The set of modifier-only `e.key` values — when the user is in the middle of
 * entering a chord in {@link KeybindingControl}, a lone modifier press isn't a
 * complete binding yet, so the caller waits for the real key.
 */
const MODIFIER_KEYS = new Set([
  "Control", "Meta", "Shift", "Alt", "AltGraph",
]);

/**
 * Capture a `keydown` event into a storage keybinding string. Used by the
 * settings KeybindingControl's "press a key" flow. Returns `null` when the
 * event is a bare modifier press (no main key yet) or Escape (cancel) — the
 * caller decides what to do with those.
 *
 * The serialized form uses `CmdOrCtrl` (not a platform-specific modifier) so
 * the same setting is portable across the user's machines, matching the
 * hand-authored `keybinding` strings on the in-tree extensions.
 */
export function captureKeybinding(e: KeyboardEvent): string | null {
  // Escape cancels capture — caller handles by exiting listen mode.
  if (e.key === "Escape") return null;
  // Bare modifier press — wait for the actual key.
  if (MODIFIER_KEYS.has(e.key)) return null;

  // Emit modifiers in a stable order: CmdOrCtrl, then Alt, then Shift, then the
  // main key. Capture normalizes meta/ctrl to the cross-platform CmdOrCtrl so a
  // setting is portable across the user's machines, matching the hand-authored
  // keybinding strings on the in-tree extensions.
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}
