import { GitBranch } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";
import { useGitStore, initGitAutoRefresh } from "../../store/gitStore";
import i18n from "../../i18n";

// The host (Sidebar) wraps `component` in React.lazy(), so the factory MUST
// return a Promise<{ default: ComponentType }> — i.e. the raw dynamic-import
// shape. Do NOT pre-wrap in lazy() here (double-wraps; React rejects it).
// Code-split: the gix IPC surface only loads when the user opens the view.

/**
 * Source Control extension (§Source Control). Registers the SCM activity-bar
 * view + the Cmd/Ctrl+Shift+G command to activate it. Auto-refreshes the git
 * status on filesystem changes once the view has been opened at least once.
 */
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.scm",
    title: i18n.t("sourceControl", { ns: "command" }),
    icon: GitBranch,
    component: () =>
      import("../../components/SourceControl/SourceControlPanel").then((m) => ({
        default: m.SourceControlPanel,
      })),
    order: 20,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.view.scm",
    title: i18n.t("showSourceControl", { ns: "command" }),
    category: "View",
    keybinding: "CmdOrCtrl+Shift+G",
    handler: () => {
      useUiStore.getState().setActiveView("workbench.scm");
      initGitAutoRefresh();
    },
  });

  ctx.registerCommand({
    id: "git.refresh",
    title: i18n.t("gitRefresh", { ns: "command" }),
    category: "Git",
    handler: () => {
      void useGitStore.getState().refresh();
    },
  });
}
