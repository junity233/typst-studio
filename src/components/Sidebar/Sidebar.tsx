import { useEffect } from "react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { onFsChanged } from "../../lib/tauri";
import { Explorer } from "./Explorer";
import { EmptyWorkspace } from "./EmptyWorkspace";

/**
 * The left sidebar: the workspace explorer when a folder is open, or an empty
 * prompt to open one. Owns the `fs_changed` listener that live-refreshes the
 * tree when files change on disk.
 */
export function Sidebar() {
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

  return (
    <aside className="sidebar">
      {rootPath === null ? <EmptyWorkspace /> : <Explorer />}
    </aside>
  );
}
