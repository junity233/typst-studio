import { BookMarked } from "lucide-react";
import i18n from "../../i18n";
import type { HostApi } from "../api";

/**
 * Bibliography panel extension (Task 4): registers a sidebar view that
 * discovers `.bib`/`.yml`/`.yaml` files in the workspace, parses them natively
 * (hayagriva, backend), and inserts `#cite(<key>)` on click. The view component
 * is lazy-loaded (Vite code-split) and auto-discovered by the sidebar renderer.
 * Mirrors the symbols/packages extension shape.
 *
 * `when: "workspace"` gates it to only when a folder is open (the sidebar shell
 * shows the empty-workspace prompt otherwise).
 */
export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.bibliography",
    title: i18n.t("title", { ns: "bibliography" }),
    icon: BookMarked,
    component: () =>
      import("../../components/Sidebar/Bibliography/BibliographyPanel").then(
        (m) => ({ default: m.BibliographyPanel }),
      ),
    order: 6,
    when: "workspace",
  });
}
