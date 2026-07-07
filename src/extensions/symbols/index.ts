import { Sigma } from "lucide-react";
import type { HostApi } from "../api";
import i18n from "../../i18n";

/**
 * Symbol panel extension (Task 3): registers a sidebar view that browses Typst
 * `sym` symbols and inserts them context-aware (math vs. markup). The view
 * component is lazy-loaded (Vite code-split) and auto-discovered by the sidebar
 * renderer. Mirrors the packages extension's shape.
 */
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.symbols",
    title: i18n.t("title", { ns: "symbols" }),
    icon: Sigma,
    component: () =>
      import("../../components/Sidebar/Symbols/SymbolsPanel").then((m) => ({
        default: m.SymbolsPanel,
      })),
    order: 5,
    when: "always",
  });
}
