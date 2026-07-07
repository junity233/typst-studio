import type { HostApi } from "../api";
import i18n from "../../i18n";
import { useCommandPaletteStore } from "../../store/commandPaletteStore";

/**
 * In-tree 'commandPalette' extension. Registers the single command that opens
 * the Command Palette, bound to `CmdOrCtrl+Shift+P`. The handler flips the
 * palette store's `open` flag; the `CommandPalette` component reads that flag
 * and renders the overlay.
 *
 * The title/category/keybinding flow back into the palette's own list (the
 * registry is the single source of command metadata), so this command is
 * discoverable from within the palette itself — a small bootstrapping nicety.
 *
 * Uses the `i18n` default import (not the `useTranslation` hook) because this
 * runs at activation time, before any component renders — mirroring how the
 * workbench extension resolves titles.
 */
export default function activate(ctx: HostApi): void {
  ctx.registerCommand({
    id: "workbench.action.openCommandPalette",
    title: i18n.t("openCommandPalette", { ns: "commandPalette" }),
    category: "View",
    keybinding: "CmdOrCtrl+Shift+P",
    handler: () => {
      useCommandPaletteStore.getState().openPalette();
    },
  });
}
