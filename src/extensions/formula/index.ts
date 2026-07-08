import type { HostApi } from "../api";
import i18n from "../../i18n";
import { useTabsStore } from "../../store/tabsStore";
import { useFormulaModalStore } from "../../store/formulaModalStore";

/**
 * In-tree 'formula' extension. Registers the "Insert Formula" command, bound to
 * `Ctrl+Alt+M`, which opens the Insert Formula modal (LaTeX → Typst math via
 * the `tylax` Rust backend, with a KaTeX live preview).
 *
 * This is the keyboard / command-palette entry point; the format-toolbar button
 * is the other entry point (it calls `useFormulaModalStore.open()` directly via
 * `ActionContext.openFormula`). Both drive the SAME store, so only one modal is
 * ever open.
 *
 * Activation is module-load-time (self-registering via
 * [`activateAll`](../index.ts) → `import.meta.glob`), so the command is in the
 * registry before any user interaction — reachable from the Command Palette and
 * the `Ctrl+Alt+M` accelerator. Uses the `i18n` default import (not the
 * `useTranslation` hook) because the title resolves at activation time, before
 * any component renders — mirroring the workbench and format extensions.
 *
 * Availability: the command is only enabled when a tab is active (inserting
 * needs a document + editor to act on).
 */
export default function activate(ctx: HostApi): void {
  ctx.registerCommand({
    id: "insert-formula",
    title: i18n.t("insertFormula", { ns: "command" }),
    category: "Insert",
    keybinding: "Ctrl+Alt+M",
    handler: () => {
      useFormulaModalStore.getState().open();
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });
}
