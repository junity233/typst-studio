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
 * Recognized named special keys, mapped to stable lowercase storage tokens.
 * The token is what `parseKeybinding` keeps in `ParsedKeybinding.key` and what
 * `matchKeybinding` compares against `e.key` (normalized via
 * {@link keyEventToToken}). Single-character keys (letters/digits/punctuation)
 * are NOT in this table — they round-trip as themselves.
 *
 * Both the friendly form a user might type ("Enter", "F1") and the exact
 * `KeyboardEvent.key` value ("Enter", "F1", "ArrowLeft") map to the same token,
 * so a binding authored as `Enter` and one captured from a keydown both parse
 * to `key: "enter"`.
 */
const NAMED_KEYS: Record<string, string> = {
  // Spelled-out aliases (case-insensitive on lookup).
  space: "space",
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  // KeyboardEvent.key spellings (already camelcase; lowercased on lookup).
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

/** Friendly display form for each named-key token, for formatKeybinding. */
const NAMED_KEY_DISPLAY: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/**
 * Is `token` (already lowercased) a function-key token like "f1".."f24"?
 * Function keys are the one named family that's a contiguous range rather than
 * a fixed set, so we recognize them by pattern instead of listing each.
 */
function isFunctionKeyToken(lower: string): boolean {
  return /^f([1-9]|1[0-9]|2[0-4])$/.test(lower);
}

/**
 * Normalize a main-key token: lower-case single letters, keep digits and
 * punctuation as-is, and recognize the named special keys in {@link NAMED_KEYS}
 * plus F1–F24. Anything else (multi-char junk like "Junk", or an unknown
 * special key) returns `""`, which `parseKeybinding` treats as an invalid
 * binding (returns null) — so a typo in settings, or an unparsable captured key,
 * is caught rather than silently stored as a dead binding.
 */
function normalizeKey(part: string): string {
  // Single char: letters lower-cased, digits/punct kept.
  if (part.length === 1) {
    return part.toLowerCase();
  }
  const lower = part.toLowerCase();
  if (isFunctionKeyToken(lower)) return lower;
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  // Reject multi-char junk: a keybinding must be a concrete single key.
  return "";
}

/**
 * Map a `KeyboardEvent.key` value to the storage token a binding uses. This is
 * the capture-side counterpart to {@link normalizeKey}: it turns the browser's
 * `e.key` ("F1", "ArrowLeft", "Enter", " ", "'") into the token form
 * ("f1"/"left"/"enter"/"space"/"'") so `captureKeybinding` emits strings that
 * round-trip through `parseKeybinding`. Returns `null` for keys we don't model
 * (e.g. "Dead", "Unidentified", or unmapped IME keys) — the caller treats that
 * as "keep listening", same as a bare modifier press.
 */
function keyEventToToken(eKey: string): string | null {
  // The space bar reports e.key === " ", but its storage token is "space"
  // (matching how a hand-authored "Ctrl+Space" binding parses). Map it
  // explicitly before the single-char path, which would otherwise keep " ".
  if (eKey === " ") return "space";
  // Single char (letter / digit / punctuation): the token is itself,
  // lowercased for letters. This is the common path for the app's bindings.
  if (eKey.length === 1) {
    return eKey.toLowerCase();
  }
  const lower = eKey.toLowerCase();
  if (isFunctionKeyToken(lower)) return lower;
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  // Unknown multi-char key (Dead, Unidentified, Process, IME compose, …).
  return null;
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

  // Main key: compare the event's key, normalized to the same storage token
  // form the parsed binding holds (see keyEventToToken). For single chars this
  // is just a lower-case compare; for named keys (F1, ArrowLeft, Enter, …) it
  // maps the event's `e.key` to the token so a stored "left" matches an
  // "ArrowLeft" event. `e.key` is always a string per the spec ("Unidentified"
  // for unrecognized), so the lookup is safe.
  return keyEventToToken(e.key) === p.key;
}

/**
 * Do two parsed bindings match the SAME set of keydown events on this platform?
 * Two bindings are equivalent when their modifier state and main key describe
 * the same chord. The only subtlety is `CmdOrCtrl`, which is a cross-platform
 * alias: on mac it means metaKey, elsewhere it means ctrlKey. So a hand-authored
 * `Ctrl+B` and a captured `CmdOrCtrl+B` collide on Windows/Linux, and a
 * `Shift+Alt+F` collides with `Alt+Shift+F` (modifier order is irrelevant) — a
 * naive string compare misses both. This mirrors the dispatcher's per-platform
 * resolution so conflict detection (KeybindingControl) flags exactly the chords
 * that would actually fight at match time.
 */
export function keybindingsEqual(a: ParsedKeybinding, b: ParsedKeybinding): boolean {
  if (a.key !== b.key) return false;
  if (a.shift !== b.shift) return false;
  if (a.alt !== b.alt) return false;
  // Resolve the accelerator side of each binding into the platform-specific
  // (ctrl, cmd) pair, then compare those pairs. A binding with cmdOrCtrl set
  // forbids the opposite raw modifier (matching matchKeybinding's "exactly one"
  // rule): CmdOrCtrl+B does NOT equal CmdOrCtrl+B + raw Ctrl on mac, etc.
  const [aCtrl, aCmd] = resolveAccelerator(a);
  const [bCtrl, bCmd] = resolveAccelerator(b);
  return aCtrl === bCtrl && aCmd === bCmd;
}

/**
 * Reduce a parsed binding's accelerator (cmdOrCtrl + raw ctrl/cmd) to the
 * concrete (ctrl, cmd) modifier pair this platform dispatches on. Mirrors
 * `matchKeybinding`'s "exactly one of meta/ctrl" rule: a cmdOrCtrl binding
 * forbids the opposite raw modifier from also being set.
 */
function resolveAccelerator(p: ParsedKeybinding): [boolean, boolean] {
  if (p.cmdOrCtrl) {
    return isMac ? [false, true] : [true, false];
  }
  return [p.ctrl, p.cmd];
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

/** Render a main key for display: upper-case single letters (B), friendly
 * names for special keys (F1, Enter, ↑), keep digits/punctuation as-is. */
function prettyKey(key: string): string {
  if (NAMED_KEY_DISPLAY[key]) return NAMED_KEY_DISPLAY[key];
  if (key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
  // Function keys (f1..f24) display upper-cased (F1).
  if (/^f[0-9]+$/.test(key)) return key.toUpperCase();
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
 * settings KeybindingControl's "press a key" flow. Returns `null` when:
 * - the event is Escape (cancel capture — caller exits listen mode), or
 * - it's a bare modifier press (no main key yet — keep listening), or
 * - the main key isn't one we can model (e.g. "Dead"/"Unidentified"/IME compose
 *   keys, which have no stable `e.key`). Returning null there keeps the control
 *   in listen mode rather than emitting a string that won't parse, won't match,
 *   and would be rejected by the backend validator on save.
 *
 * The serialized form uses `CmdOrCtrl` (not a platform-specific modifier) so
 * the same setting is portable across the user's machines, matching the
 * hand-authored `keybinding` strings on the in-tree extensions. Named/special
 * keys are emitted via {@link keyEventToToken} so an F1 or arrow press round-
 * trips through `parseKeybinding` (e.g. `ArrowLeft` → "left" → parses fine),
 * instead of the old behavior of emitting the raw multi-char `e.key`, which
 * produced an unparseable, never-matching, backend-rejected binding.
 */
export function captureKeybinding(e: KeyboardEvent): string | null {
  // Escape cancels capture — caller handles by exiting listen mode.
  if (e.key === "Escape") return null;
  // Bare modifier press — wait for the actual key.
  if (MODIFIER_KEYS.has(e.key)) return null;

  const token = keyEventToToken(e.key);
  // Unknown / unmappable key (Dead, Unidentified, IME compose, …): keep
  // listening rather than emit an unparseable binding.
  if (token === null) return null;

  // Emit modifiers in a stable order: CmdOrCtrl, then Alt, then Shift, then the
  // main key. Capture normalizes meta/ctrl to the cross-platform CmdOrCtrl so a
  // setting is portable across the user's machines, matching the hand-authored
  // keybinding strings on the in-tree extensions.
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(token);
  return parts.join("+");
}
