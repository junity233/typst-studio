import { Suspense, lazy, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useViews } from "../../extensions/hooks";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { onFsChanged } from "../../lib/tauri";
import { EmptyWorkspace } from "./EmptyWorkspace";

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
  "workbench.scm": "sidebar:sourceControl.title",
};

/**
 * The left sidebar: a host for every registered view, kept alive
 * simultaneously and toggled by CSS so switching tabs never unmounts a view.
 *
 * Why keep-alive: each view owns ephemeral state (Explorer's inline-rename
 * buffer, Search's results + per-file collapse set, Source Control's commit
 * message + refreshed status, Outline's collapse set + active-row scroll
 * sync). Mounting only the active view — the previous design — wiped all of
 * that on every tab switch and forced a re-load (re-search, re-fetch, lost
 * cursor in the commit box). Rendering every view once and showing/hiding
 * via `hidden` preserves each view's component tree across switches (the
 * VSCode sidebar model).
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

  // Live-refresh the tree on external filesystem changes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onFsChanged(() => {
      void refreshAll();
    }).then((fn) => {
      if (cancelled) {
        // Already cleaned up — release immediately so the listener never fires.
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // TODO(phase2): extract useTauriListener helper; App.tsx has the same race.
  }, [refreshAll]);

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
        {rootPath === null && <EmptyWorkspace />}

        {/* Every registered view is mounted once and kept alive. Visibility
            is CSS-driven (`hidden` attribute) so React never unmounts a view
            when the user switches tabs — its internal state, scroll position,
            and lazy-loaded chunk all survive. */}
        {views.map((v) => {
          const ViewComponent = lazy(v.component);
          const isActive = v.id === activeViewId;
          // When no workspace is open, hide ALL views (EmptyWorkspace covers
          // the body). When a workspace is open, show only the active one.
          const visible = rootPath !== null && isActive;
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
                <ViewComponent viewId={v.id} />
              </Suspense>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
