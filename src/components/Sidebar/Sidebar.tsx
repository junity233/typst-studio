import { Suspense, lazy, useEffect, useMemo } from "react";
import { useViews } from "../../extensions/hooks";
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

  // Derive the active view from the subscribed list (not a direct registry
  // read) so registry mutations trigger re-renders.
  const view = views.find((v) => v.id === activeViewId);

  // Unconditional hook: the lazy wrapper is recreated only when the view id
  // changes, so a stable active view does not remount on every re-render
  // (preserves the child view's local state, e.g. Explorer's pendingNew input).
  const ViewComponent = useMemo(
    () => (view ? lazy(view.component) : null),
    [view?.id],
  );

  // All hooks above this line. Early returns below.
  if (rootPath === null) {
    return (
      <aside className="sidebar">
        <EmptyWorkspace />
      </aside>
    );
  }

  if (ViewComponent === null) {
    return <aside className="sidebar" />;
  }

  // After this point both view and ViewComponent are guaranteed non-null.
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{view!.title}</span>
      </div>
      <div className="sidebar-body">
        <Suspense fallback={<div className="sidebar-loading">Loading…</div>}>
          <ViewComponent viewId={view!.id} />
        </Suspense>
      </div>
    </aside>
  );
}
