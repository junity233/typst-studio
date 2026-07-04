import { Search } from "lucide-react";
import type { HostApi } from "../api";
import { useSearchStore } from "../../store/searchStore";
import { useUiStore } from "../../store/uiStore";

// The Search view's sidebar entry. The real UI is the BOTTOM SearchPanel
// (rendered by Workbench, not the sidebar body), so the sidebar slot holds a
// null placeholder — it just needs to occupy the Activity Bar slot so the icon
// shows and highlights correctly.
const SearchSidebarPlaceholder = () => null;

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.search",
    title: "Search",
    icon: Search,
    component: () => Promise.resolve({ default: SearchSidebarPlaceholder }),
    order: 10,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.action.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "CmdOrCtrl+Shift+F",
    handler: () => {
      useSearchStore.getState().show();
      // Also activate the search "view" in the activity bar so the icon
      // highlights (the panel itself is the bottom SearchPanel).
      useUiStore.getState().setActiveView("workbench.search");
    },
  });
}
