import type { HostApi } from "../api";
import i18n from "../../i18n";
import { hasActiveTab } from "../../store/tabsStore";
import { editorApiRef } from "../../components/Editor/editorApiRef";

/**
 * In-tree 'formatShortcuts' extension: registers keyboard shortcuts for the
 * inline-formatting and heading actions that the FormatToolbar exposes as
 * buttons. Each handler calls the SAME editor methods the toolbar uses
 * (toggleWrap / toggleLinePrefix from editorEdit.ts), so the keyboard and the
 * toolbar are always in sync — no second implementation of the formatting
 * logic, and toggling is idempotent either way (pressing Ctrl+B on `*foo*`
 * removes the bold, just like clicking the Bold button).
 *
 * The commands are declared as one data table below: the Typst literals stay
 * pinned to formatActions.ts (the toolbar's single source of truth) so a typo
 * is caught by the unit tests that cross-check the two, rather than discovered
 * in the UI: bold `*…*`, italic `_…_`, strike `#strike[…]`, inline code
 * `` `…` ``, headings `= ` / `== ` / `=== `.
 *
 * Activation is module-load-time (self-registering via
 * [`activateAll`](../index.ts) → `import.meta.glob`), so the commands are in the
 * registry before any user interaction — reachable from their accelerators and
 * the Command Palette. Uses the `i18n` default import (not the `useTranslation`
 * hook) because titles resolve at activation time, before any component renders
 * — mirroring the workbench, format, and formula extensions.
 *
 * Availability: every command is only enabled when a tab is active (formatting
 * needs a document + editor to act on). The deeper gate (an editor instance is
 * live) is handled by editorApiRef.current being null until onReady — each
 * handler no-ops then.
 *
 * Keybindings declared here are the DEFAULTS; users may override any of them in
 * Settings → Keyboard Shortcuts. The dispatcher (useAppCommands) reads
 * `keybindings.<cmdId>` to resolve the effective binding, falling back to the
 * `keybinding` field here.
 */

/** One row per formatting command: a wrap action (`prefix…suffix`) or a
 *  heading action (line prefix). The third wrap element is the placeholder
 *  label toggleWrap inserts around an empty selection. */
const FORMAT_COMMANDS: ReadonlyArray<{
  id: string;
  titleKey: string;
  keybinding: string;
  wrap?: [prefix: string, suffix: string, placeholder: string];
  linePrefix?: string;
}> = [
  // ---- Inline emphasis (wrap actions) ----
  { id: "format.bold", titleKey: "bold", keybinding: "Ctrl+B", wrap: ["*", "*", "bold"] },
  { id: "format.italic", titleKey: "italic", keybinding: "Ctrl+I", wrap: ["_", "_", "italic"] },
  {
    id: "format.strikethrough",
    titleKey: "strikethrough",
    keybinding: "Ctrl+Shift+X",
    wrap: ["#strike[", "]", "text"],
  },
  { id: "format.code", titleKey: "inlineCode", keybinding: "Ctrl+`", wrap: ["`", "`", "code"] },
  // ---- Headings (line-prefix actions) ----
  { id: "format.heading1", titleKey: "heading1", keybinding: "Ctrl+1", linePrefix: "= " },
  { id: "format.heading2", titleKey: "heading2", keybinding: "Ctrl+2", linePrefix: "== " },
  { id: "format.heading3", titleKey: "heading3", keybinding: "Ctrl+3", linePrefix: "=== " },
];

/** Marker the editor isn't ready yet — keeps the type narrow at call sites. */
function noEditor(): void {
  // No-op: editorApiRef.current is null until the editor reports ready. A
  // keystroke landing in that brief window (app just launched, no tab focused)
  // is silently ignored; enablement (activeId !== null) already filters most.
}

export default function activate(ctx: HostApi): void {
  for (const { id, titleKey, keybinding, wrap, linePrefix } of FORMAT_COMMANDS) {
    ctx.registerCommand({
      id,
      title: i18n.t(titleKey, { ns: "command" }),
      category: "Format",
      keybinding,
      handler: () => {
        const api = editorApiRef.current;
        if (!api) return noEditor();
        if (wrap) {
          api.toggleWrap(wrap[0], wrap[1], wrap[2]);
        } else {
          api.toggleLinePrefix(linePrefix!);
        }
      },
      enablement: hasActiveTab,
    });
  }
}
