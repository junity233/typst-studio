import { Bot } from "lucide-react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";
import i18n from "../../i18n";

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.assistant",
    title: i18n.t("assistant:title"),
    icon: Bot,
    component: () =>
      import("../../components/Assistant/AssistantPanel").then((m) => ({
        default: m.AssistantPanel,
      })),
    order: 30,
    when: "always",
  });

  ctx.registerCommand({
    id: "workbench.action.showAssistant",
    title: i18n.t("showAssistant", { ns: "command" }),
    category: "AI",
    keybinding: "CmdOrCtrl+Shift+I",
    handler: () => {
      useUiStore.getState().setActiveView("workbench.assistant");
    },
  });
}
