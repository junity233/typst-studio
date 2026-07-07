import { useTranslation } from "react-i18next";
import { useViews } from "../../extensions/hooks";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

const VIEW_TITLE_KEYS: Record<string, string> = {
  "workbench.explorer": "sidebar:explorer.title",
  "workbench.outline": "sidebar:outline.title",
  "workbench.search": "sidebar:search.title",
  "workbench.assistant": "sidebar:assistant.title",
  "workbench.scm": "sidebar:sourceControl.title",
  "workbench.symbols": "sidebar:symbols.title",
};

/**
 * The Activity Bar: a narrow vertical strip of icon buttons on the far left of
 * the workbench, one per registered view. Clicking an icon toggles that view
 * into the sidebar (VSCode semantics — click the active icon to hide the
 * sidebar). Views gated `when: "workspace"` are disabled until a folder opens.
 */
export function ActivityBar() {
  const { t } = useTranslation(["commandBar", "sidebar"]);
  const views = useViews();
  const activeViewId = useUiStore((s) => s.activeViewId);
  const toggleView = useUiStore((s) => s.toggleView);
  const hasWorkspace = useWorkspaceStore((s) => s.rootPath !== null);

  return (
    <nav className="activity-bar" role="toolbar" aria-label={t("views")}>
      {views.map((v) => {
        const disabled = v.when === "workspace" && !hasWorkspace;
        const isActive = activeViewId === v.id;
        const titleKey = VIEW_TITLE_KEYS[v.id];
        const title = titleKey ? t(titleKey) : v.title;
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            id={`activity-item-${v.id}`}
            className={`activity-item${isActive ? " active" : ""}`}
            title={title}
            aria-label={title}
            disabled={disabled}
            aria-pressed={isActive}
            onClick={() => toggleView(v.id)}
          >
            <Icon size={22} />
          </button>
        );
      })}
    </nav>
  );
}
