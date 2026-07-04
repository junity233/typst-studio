import { Suspense, lazy, useEffect } from "react";
import { viewRegistry } from "../../extensions/registry";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { onFsChanged } from "../../lib/tauri";
import { EmptyWorkspace } from "./EmptyWorkspace";

/**
 * The left sidebar: a host for the currently active view from the ViewRegistry.
 * With no workspace open it renders the EmptyWorkspace prompt; otherwise it
 * resolves the active view's lazy component and mounts it inside a header +
 * body shell. Owns the `fs_changed` listener that live-refreshes the tree when
 * files change on disk (consumed by the Explorer view via the workspace store).
 */
export function Sidebar() {
  const activeViewId = useUiStore((s) => s.activeViewId);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const refreshAll = useWorkspaceStore((s) => s.refreshAll);

  // Live-refresh the tree on external filesystem changes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onFsChanged(() => {
      void refreshAll();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refreshAll]);

  if (rootPath === null) {
    return (
      <aside className="sidebar">
        <EmptyWorkspace />
      </aside>
    );
  }

  const view = activeViewId ? viewRegistry.get(activeViewId) : undefined;
  if (!view) {
    return <aside className="sidebar" />;
  }

  const ViewComponent = lazy(view.component);
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{view.title}</span>
      </div>
      <div className="sidebar-body">
        <Suspense fallback={<div className="sidebar-loading">Loading…</div>}>
          <ViewComponent viewId={view.id} />
        </Suspense>
      </div>
    </aside>
  );
}
