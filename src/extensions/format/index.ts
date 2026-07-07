import type { HostApi } from "../api";
import i18n from "../../i18n";
import { useTabsStore } from "../../store/tabsStore";

/**
 * In-tree 'format' extension. Registers the "Format Document" command, bound
 * to the standard VS Code accelerator `Shift+Alt+F`. The handler routes to
 * tinymist's `textDocument/formatting` via Monaco's built-in
 * `editor.action.formatDocument` action.
 *
 * Activation is module-load-time (self-registering via
 * [`activateAll`](../index.ts) → `import.meta.glob`), so the command is in the
 * registry before any user interaction — reachable from the Edit menu, the
 * native accelerator, and (if surfaced) the Command Palette. Uses the `i18n`
 * default import (not the `useTranslation` hook) because titles resolve at
 * activation time, before any component renders — mirroring the workbench and
 * commandPalette extensions.
 *
 * Availability: the command is only enabled when a tab is active (formatting
 * needs a document to act on). The deeper gate (tinymist running) is checked
 * inside [`formatActiveDocument`](../../components/Editor/formatDocument.ts),
 * which also surfaces a friendly alert when the language server is missing.
 */
export default function activate(ctx: HostApi): void {
  ctx.registerCommand({
    id: "format-document",
    title: i18n.t("formatDocument", { ns: "command" }),
    category: "Edit",
    keybinding: "Shift+Alt+F",
    handler: async () => {
      const { formatActiveDocument } = await import(
        "../../components/Editor/formatDocument"
      );
      const result = await formatActiveDocument();
      if (!result.formatted && result.reason === "no-lsp") {
        window.alert(i18n.t("formatRequiresLsp", { ns: "command" }));
      }
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });
}
