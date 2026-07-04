import { lazy } from "react";
import { Files } from "lucide-react";
import type { HostApi } from "../api";

// Vite splits this into its own chunk
const ExplorerView = lazy(() =>
  import("../../components/Sidebar/Explorer").then((m) => ({ default: m.Explorer })),
);

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.explorer",
    title: "Explorer",
    icon: Files,
    component: () => Promise.resolve({ default: ExplorerView }),
    order: 0,
    when: "workspace",
  });
}
