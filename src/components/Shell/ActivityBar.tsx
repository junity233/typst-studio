import { useViews } from "../../extensions/hooks";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSearchStore } from "../../store/searchStore";

/**
 * The Activity Bar: a narrow vertical strip of icon buttons on the far left of
 * the workbench, one per registered view. Clicking an icon toggles that view
 * into the sidebar (VSCode semantics — click the active icon to hide the
 * sidebar). Views gated `when: "workspace"` are disabled until a folder opens.
 *
 * The Search view is special: its real UI is the bottom SearchPanel, not the
 * sidebar body. Clicking its icon toggles the panel (and highlights while
 * visible), instead of the normal `toggleView` sidebar flow.
 */
export function ActivityBar() {
  const views = useViews();
  const activeViewId = useUiStore((s) => s.activeViewId);
  const toggleView = useUiStore((s) => s.toggleView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const hasWorkspace = useWorkspaceStore((s) => s.rootPath !== null);
  const searchShow = useSearchStore((s) => s.show);
  const searchHide = useSearchStore((s) => s.hide);
  const searchVisible = useSearchStore((s) => s.visible);

  return (
    <nav className="activity-bar" role="toolbar" aria-label="Views">
      {views.map((v) => {
        const disabled = v.when === "workspace" && !hasWorkspace;
        // The Search view's "active" state tracks its bottom panel visibility,
        // not the sidebar's activeViewId (the panel is the real UI).
        const isSearch = v.id === "workbench.search";
        const isActive = isSearch ? searchVisible : activeViewId === v.id;
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            className={`activity-item${isActive ? " active" : ""}`}
            title={v.title}
            disabled={disabled}
            aria-pressed={isActive}
            onClick={() => {
              if (isSearch) {
                if (searchVisible) {
                  searchHide();
                } else {
                  searchShow();
                  // Mark the search view active so the icon stays highlighted
                  // once the sidebar re-renders (the panel is the real UI).
                  setActiveView("workbench.search");
                }
              } else {
                toggleView(v.id);
              }
            }}
          >
            <Icon size={22} />
          </button>
        );
      })}
    </nav>
  );
}
