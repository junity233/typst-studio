import { Package } from "lucide-react";
import type { HostApi } from "../api";
import i18n from "../../i18n";

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.packages",
    title: i18n.t("title", { ns: "packages" }),
    icon: Package,
    component: () =>
      import("../../components/Sidebar/Packages/PackagesPanel").then((m) => ({
        default: m.PackagesPanel,
      })),
    order: 4,
    when: "always",
  });
}
