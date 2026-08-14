import { Suspense, lazy, useEffect, useRef, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useViews } from "../../extensions/hooks";
import type { ViewContribution } from "../../extensions/registry";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { onFsChanged } from "../../lib/tauri";
import { useTauriListener } from "../../hooks/useTauriListener";
import { useProjectConfigStore } from "../../store/projectConfigStore";
import { EmptyWorkspace } from "./EmptyWorkspace";

/**
 * Stable lazy-component cache, keyed by view id. Each call to `lazy()` returns
 * a NEW wrapper component type; if we called it inside the render `.map()` the
 * way the keep-alive design used to, every Sidebar re-render would produce a
 * fresh `<ViewComponent>` type for React to reconcile. React treats a changed
 * component type as "different component" and UNMOUNTS the old subtree —
 * wiping each view's internal state and re-running its effects (Source
 * Control's IPC refresh, Search's collapse set, etc.), defeating the entire
 * `hidden`-based keep-alive. Caching one lazy wrapper per view id keeps the
 * type referentially stable across renders, so React reuses the subtree and
 * the CSS show/hide toggle is what actually controls visibility.
 */
const lazyViewCache = new Map<string, ReturnType<typeof lazy>>();

/** Get (or first-time create) the stable lazy component for a view. */
function getLazyView(view: ViewContribution) {
  let Component = lazyViewCache.get(view.id);
  if (!Component) {
    Component = lazy(view.component);
    lazyViewCache.set(view.id, Component);
  }
  return Component;
}

/**
 * Built-in sidebar view ids → translation keys. View titles themselves are
 * contributed by extensions (which other i18n phases own), so the Sidebar maps
 * the known built-in view ids to localized titles here. Unknown/contributed
 * views fall back to their contributed `title`.
 */
const VIEW_TITLE_KEYS: Record<string, string> = {
  "workbench.explorer": "sidebar:explorer.title",
  "workbench.outline": "sidebar:outline.title",
  "workbench.search": "sidebar:search.title",
  "workbench.packages": "packages:title",
  "workbench.project": "project:title",
  "workbench.assistant": "sidebar:assistant.title",
};

/**
 * Workspace-scoped view ids whose local state is bound to ONE workspace and
 * must be rebuilt when the root changes. `openWorkspace` switches rootPath
 * old→new without passing through null, and the keep-alive shell never
 * unmounts mounted views — so the Project panel's half-edited form would
 * otherwise survive into the new workspace, where a stray Save would write the
 * OLD values into the new workspace's `.typstpro`. A `key={rootPath}` remount
 * discards that state cleanly; on re-mount the panel seeds its form from the
 * (still-old) config and the config-sync effect adopts the new workspace's
 * config once the broadcast arrives.
 */
const REMOUNT_ON_ROOT_CHANGE = new Set(["workbench.project"]);

/** Every view receives its current visibility so data-heavy panels can defer
 *  fetching until the user actually opens the tab (see PackagesPanel). */
type SidebarViewComponent = ComponentType<{ viewId: string; visible: boolean }>;

/** Whether a contributed view may be shown in the current host state. */
export function isSidebarViewVisible(
  view: Pick<ViewContribution, "id" | "when">,
  activeViewId: string | null,
  rootPath: string | null,
): boolean {
  return (
    view.id === activeViewId &&
    (view.when !== "workspace" || rootPath !== null)
  );
}

/** The workspace prompt must not cover views that explicitly work untitled. */
export function shouldShowEmptyWorkspace(
  activeView: Pick<ViewContribution, "when"> | undefined,
  rootPath: string | null,
): boolean {
  return rootPath === null && activeView?.when !== "always";
}

/**
 * Preload every eligible view at startup: mount on first render rather than on
 * first activation, so switching tabs is instant. A view is ineligible only
 * while it is workspace-gated and no workspace is open yet — once a root exists
 * it too mounts eagerly. Visibility is still CSS-driven (`hidden` attribute),
 * so non-active views stay alive but out of the layout.
 */
export function shouldMountSidebarView(
  view: Pick<ViewContribution, "when">,
  rootPath: string | null,
): boolean {
  return view.when !== "workspace" || rootPath !== null;
}

/**
 * The left sidebar: every eligible view is preloaded at startup and stays
 * alive, toggled by CSS so switching tabs preserves its local state.
 *
 * Why keep-alive: each view owns ephemeral state (Explorer's inline-rename
 * buffer, Search's results + per-file collapse set, Source Control's commit
 * message + refreshed status, Outline's collapse set + active-row scroll
 * sync). Mounting only the active view wiped all of that on every tab switch
 * and forced a re-load (re-search, re-fetch, lost cursor in the commit box).
 * Rendering every eligible view up front and showing/hiding via `hidden`
 * preserves each view's component tree across switches (the VSCode sidebar
 * model), and preloading means there is no first-click chunk fetch or
 * initialization stall when a tab is opened for the first time. This only
 * holds because each view's lazy wrapper is memoized in `lazyViewCache` —
 * recreating `lazy()` per render would change each view's component type and
 * force React to unmount it regardless of `hidden`.
 *
 * With no workspace open, the EmptyWorkspace prompt shows as a stacked layer
 * on top of the (idle) views, so re-opening a workspace restores whatever
 * state the views already had.
 */
export function Sidebar() {
  const { t } = useTranslation("sidebar");
  const activeViewId = useUiStore((s) => s.activeViewId);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const refreshAll = useWorkspaceStore((s) => s.refreshAll);
  const views = useViews();

  // Live-refresh the tree on external filesystem changes. The tree refresh is
  // immediate, but the .typ candidate rescan is debounced (500ms trailing):
  // it walks every workspace .typ file, and each save itself fires a watcher
  // event — bursting them would rescan repeatedly for one batch of changes.
  const typRescanTimerRef = useRef<number | null>(null);
  useTauriListener(onFsChanged, () => {
    void refreshAll();
    if (typRescanTimerRef.current !== null) window.clearTimeout(typRescanTimerRef.current);
    typRescanTimerRef.current = window.setTimeout(() => {
      typRescanTimerRef.current = null;
      // Keep the project-config main-file candidate list fresh too, so the
      // Project panel's dropdown reflects newly added/removed .typ files.
      void useProjectConfigStore.getState().refreshTypFiles();
    }, 500);
  });
  useEffect(
    () => () => {
      if (typRescanTimerRef.current !== null) window.clearTimeout(typRescanTimerRef.current);
    },
    [],
  );

  // The active view drives the header title.
  const activeView = views.find((v) => v.id === activeViewId);
  const titleKey = activeView ? VIEW_TITLE_KEYS[activeView.id] : undefined;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">
          {activeView
            ? titleKey
              ? t(titleKey)
              : activeView.title
            : ""}
        </span>
      </div>
      <div className="sidebar-body">
        {/* EmptyWorkspace sits as a sibling layer; visible only when no
            workspace is open. The views below stay mounted underneath it,
            idle, so reopening a workspace restores their state instantly. */}
        {shouldShowEmptyWorkspace(activeView, rootPath) && <EmptyWorkspace />}

        {/* Every eligible view is preloaded up front and kept alive. Visibility
            is CSS-driven (`hidden` attribute), preserving local state and scroll
            position; preloading avoids a first-click chunk fetch/init stall. */}
        {views.map((v) => {
          if (!shouldMountSidebarView(v, rootPath)) {
            return null;
          }
          const ViewComponent = getLazyView(v) as SidebarViewComponent;
          // Workspace-gated views stay behind EmptyWorkspace without a root;
          // "always" views (notably Outline) remain usable for untitled docs.
          const visible = isSidebarViewVisible(v, activeViewId, rootPath);
          return (
            <div
              key={v.id}
              className="sidebar-view"
              // `hidden` is the correct keep-alive toggle: the browser removes
              // the element from the layout (display:none) without telling
              // React to unmount it. Toggling it back restores the exact DOM
              // subtree, preserving component state, scroll, focus, and the
              // already-resolved lazy chunk.
              hidden={!visible}
              role="tabpanel"
              aria-hidden={!visible}
              aria-labelledby={`activity-item-${v.id}`}
            >
              <Suspense
                fallback={<div className="sidebar-loading">{t("loading")}</div>}
              >
                <ViewComponent
                  viewId={v.id}
                  visible={visible}
                  // Views whose state is workspace-bound (see
                  // REMOUNT_ON_ROOT_CHANGE) rebuild on workspace switch, so no
                  // unsaved edits leak across workspaces.
                  key={REMOUNT_ON_ROOT_CHANGE.has(v.id) ? rootPath : undefined}
                />
              </Suspense>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
