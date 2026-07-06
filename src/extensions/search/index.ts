import { Search } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";
import i18n from "../../i18n";

// The host (Sidebar) wraps `component` in React.lazy(), so the factory MUST
// return a Promise<{ default: ComponentType }> — i.e. the raw dynamic-import
// shape. Do NOT pre-wrap in lazy() here (double-wraps; React rejects it with
// "Lazy element type must resolve to a class or function"). Same pattern as
// the Explorer/Outline/SCM views.
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.search",
    title: i18n.t("search", { ns: "command" }),
    icon: Search,
    component: () =>
      import("../../components/Search/SearchPanel").then((m) => ({ default: m.SearchPanel })),
    order: 20,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.action.findInFiles",
    title: i18n.t("findInFiles", { ns: "command" }),
    category: "Search",
    keybinding: "CmdOrCtrl+Shift+F",
    handler: () => {
      // Activate the search view in the sidebar (same flow as clicking the icon).
      useUiStore.getState().setActiveView("workbench.search");
    },
  });
}
