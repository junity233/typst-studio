import { lazy } from "react";
import { Search } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";

// The Search view's sidebar body — the real SearchPanel, lazy-loaded so it's
// code-split from the main bundle (same pattern as the Explorer/SCM views).
const SearchView = lazy(() =>
  import("../../components/Search/SearchPanel").then((m) => ({ default: m.SearchPanel })),
);

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.search",
    title: "Search",
    icon: Search,
    component: () => Promise.resolve({ default: SearchView }),
    order: 10,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.action.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "CmdOrCtrl+Shift+F",
    handler: () => {
      // Activate the search view in the sidebar (same flow as clicking the icon).
      useUiStore.getState().setActiveView("workbench.search");
    },
  });
}
