import { Files } from "lucide-react";
import type { HostApi } from "../api";

// The host (Sidebar) wraps `component` in React.lazy(), so the factory MUST
// return a Promise<{ default: ComponentType }> — i.e. the raw dynamic-import
// shape. Do NOT pre-wrap in lazy() here: that double-wraps and React rejects
// it ("Lazy element type must resolve to a class or function").
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.explorer",
    title: "Explorer",
    icon: Files,
    component: () =>
      import("../../components/Sidebar/Explorer").then((m) => ({ default: m.Explorer })),
    order: 0,
    when: "workspace",
  });
}
