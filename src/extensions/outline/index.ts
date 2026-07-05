import { List } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";
import i18n from "../../i18n";

// The host (Sidebar) wraps `component` in React.lazy(), so the factory MUST
// return a Promise<{ default: ComponentType }> — i.e. the raw dynamic-import
// shape. Do NOT pre-wrap in lazy() here (double-wraps; React rejects it).
export default function activate(ctx: HostApi): void {
  // The Outline view is always available (a single untitled doc can have
  // headings), so `when: "always"` rather than `workspace`.
  ctx.registerView({
    id: "workbench.outline",
    title: i18n.t("outline", { ns: "command" }),
    icon: List,
    component: () =>
      import("../../components/Outline/OutlinePanel").then((m) => ({
        default: m.OutlinePanel,
      })),
    order: 30,
    when: "always",
  });

  ctx.registerCommand({
    id: "workbench.view.outline",
    title: i18n.t("showOutline", { ns: "command" }),
    category: "View",
    keybinding: "CmdOrCtrl+Shift+O",
    handler: () => useUiStore.getState().setActiveView("workbench.outline"),
  });
}
