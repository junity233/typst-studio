import type { HostApi } from "../api";
import i18n from "../../i18n";
import { useTabsStore } from "../../store/tabsStore";
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
 * The Typst literal strings below are pinned to formatActions.ts (the toolbar's
 * single source of truth) so a typo here is caught by the unit tests that
 * cross-check the two, rather than discovered in the UI:
 *   bold `*…*`, italic `_…_`, strike `#strike[…]`, inline code `` `…` ``,
 *   headings `= ` / `== ` / `=== `.
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

/** Marker the editor isn't ready yet — keeps the type narrow at call sites. */
function noEditor(): void {
  // No-op: editorApiRef.current is null until the editor reports ready. A
  // keystroke landing in that brief window (app just launched, no tab focused)
  // is silently ignored; enablement (activeId !== null) already filters most.
}

export default function activate(ctx: HostApi): void {
  // ---- Inline emphasis (wrap actions) ----
  ctx.registerCommand({
    id: "format.bold",
    title: i18n.t("bold", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+B",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleWrap("*", "*", "bold");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "format.italic",
    title: i18n.t("italic", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+I",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleWrap("_", "_", "italic");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "format.strikethrough",
    title: i18n.t("strikethrough", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+Shift+X",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleWrap("#strike[", "]", "text");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "format.code",
    title: i18n.t("inlineCode", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+`",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleWrap("`", "`", "code");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  // ---- Headings (line-prefix actions) ----
  ctx.registerCommand({
    id: "format.heading1",
    title: i18n.t("heading1", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+1",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleLinePrefix("= ");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "format.heading2",
    title: i18n.t("heading2", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+2",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleLinePrefix("== ");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "format.heading3",
    title: i18n.t("heading3", { ns: "command" }),
    category: "Format",
    keybinding: "Ctrl+3",
    handler: () => {
      const api = editorApiRef.current;
      if (!api) return noEditor();
      api.toggleLinePrefix("=== ");
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });
}
