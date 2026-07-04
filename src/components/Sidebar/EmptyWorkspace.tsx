import { useWorkspaceStore } from "../../store/workspaceStore";
import { toIpcError } from "../../lib/ipc-error";

/**
 * Shown in the sidebar when no workspace folder is open. Offers to open a
 * folder (native dialog). Documents can still be opened individually via the
 * File menu, but the file tree needs a workspace root.
 */
export function EmptyWorkspace() {
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const handleOpen = () => {
    void openWorkspace().catch((e) => {
      console.error("[EmptyWorkspace] open failed:", e);
      window.alert(`Could not open folder: ${toIpcError(e).message}`);
    });
  };

  return (
    <div className="sidebar-empty">
      <p className="sidebar-empty-title">No folder open</p>
      <p className="sidebar-empty-body">
        Open a folder to browse its files as a workspace tree, with{" "}
        <code>#include</code> and <code>#image()</code> resolution.
      </p>
      <button className="btn-primary sidebar-empty-action" onClick={handleOpen}>
        Open Folder…
      </button>
    </div>
  );
}
