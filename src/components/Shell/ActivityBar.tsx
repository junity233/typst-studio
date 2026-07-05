import { useTranslation } from "react-i18next";
import { useViews } from "../../extensions/hooks";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

/**
 * The Activity Bar: a narrow vertical strip of icon buttons on the far left of
 * the workbench, one per registered view. Clicking an icon toggles that view
 * into the sidebar (VSCode semantics — click the active icon to hide the
 * sidebar). Views gated `when: "workspace"` are disabled until a folder opens.
 */
export function ActivityBar() {
  const { t } = useTranslation("commandBar");
  const views = useViews();
  const activeViewId = useUiStore((s) => s.activeViewId);
  const toggleView = useUiStore((s) => s.toggleView);
  const hasWorkspace = useWorkspaceStore((s) => s.rootPath !== null);

  return (
    <nav className="activity-bar" role="toolbar" aria-label={t("views")}>
      {views.map((v) => {
        const disabled = v.when === "workspace" && !hasWorkspace;
        const isActive = activeViewId === v.id;
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            className={`activity-item${isActive ? " active" : ""}`}
            title={v.title}
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
