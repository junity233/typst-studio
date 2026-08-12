import { FolderCog } from "lucide-react";
import i18n from "../../i18n";
import type { HostApi } from "../api";

/**
 * Project panel extension: registers a sidebar view that edits the workspace's
 * `.typstpro` (main compile file + project title) and toggles project-preview
 * mode. The view component is lazy-loaded (Vite code-split) and auto-discovered
 * by the sidebar renderer. Mirrors the bibliography/packages extension shape.
 *
 * `when: "workspace"` gates it to only when a folder is open (the sidebar shell
 * shows the empty-workspace prompt otherwise).
 */
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.project",
    title: i18n.t("title", { ns: "project" }),
    icon: FolderCog,
    component: () =>
      import("../../components/Sidebar/Project/ProjectPanel").then(
        (m) => ({ default: m.ProjectPanel }),
      ),
    order: 45,
    when: "workspace",
  });
}
