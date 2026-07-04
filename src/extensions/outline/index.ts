import { lazy } from "react";
import { List } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";

// Vite splits this into its own chunk, matching the Explorer/Search extensions.
const OutlineView = lazy(() =>
  import("../../components/Outline/OutlinePanel").then((m) => ({
    default: m.OutlinePanel,
  })),
);

export default function activate(ctx: HostApi): void {
  // The Outline view is always available (a single untitled doc can have
  // headings), so `when: "always"` rather than `workspace`.
  ctx.registerView({
    id: "workbench.outline",
    title: "Outline",
    icon: List,
    component: () => Promise.resolve({ default: OutlineView }),
    order: 30,
    when: "always",
  });

  ctx.registerCommand({
    id: "workbench.view.outline",
    title: "Show Outline",
    category: "View",
    keybinding: "CmdOrCtrl+Shift+O",
    handler: () => useUiStore.getState().setActiveView("workbench.outline"),
  });
}
