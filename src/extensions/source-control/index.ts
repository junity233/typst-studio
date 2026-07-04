import { lazy } from "react";
import { GitBranch } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";
import { useGitStore, initGitAutoRefresh } from "../../store/gitStore";

// The Source Control sidebar body. Code-split so the gix IPC surface only
// loads when the user opens the view.
const SourceControlView = lazy(() =>
  import("../../components/SourceControl/SourceControlPanel").then((m) => ({
    default: m.SourceControlPanel,
  })),
);

/**
 * Source Control extension (§Source Control). Registers the SCM activity-bar
 * view + the Cmd/Ctrl+Shift+G command to activate it. Auto-refreshes the git
 * status on filesystem changes once the view has been opened at least once.
 */
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.scm",
    title: "Source Control",
    icon: GitBranch,
    component: () => Promise.resolve({ default: SourceControlView }),
    order: 20,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.view.scm",
    title: "Show Source Control",
    category: "View",
    keybinding: "CmdOrCtrl+Shift+G",
    handler: () => {
      useUiStore.getState().setActiveView("workbench.scm");
      initGitAutoRefresh();
    },
  });

  ctx.registerCommand({
    id: "git.refresh",
    title: "Git: Refresh",
    category: "Git",
    handler: () => {
      void useGitStore.getState().refresh();
    },
  });
}
