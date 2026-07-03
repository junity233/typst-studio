import { useActiveDocument } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

/**
 * A breadcrumb showing the active document's position: the workspace name (if a
 * folder is open) followed by the file's path relative to it, plus a dirty
 * indicator. For a file outside the workspace (or with no workspace), shows the
 * bare filename. For an untitled tab, shows "Untitled".
 */
export function Breadcrumb() {
  const activeTab = useActiveDocument();
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const workspaceName = useWorkspaceStore((s) => s.name);

  if (activeTab === null) {
    return (
      <div className="breadcrumb">
        <span className="breadcrumb-placeholder">Typst Studio</span>
      </div>
    );
  }

  // Derive the relative path within the workspace, or fall back to the bare
  // filename / "Untitled".
  let crumbs: string[] = [];
  if (activeTab.path !== null) {
    if (rootPath !== null && activeTab.path.startsWith(rootPath + "/")) {
      const rel = activeTab.path.slice(rootPath.length + 1);
      crumbs = rel.split("/").filter(Boolean);
    } else {
      // Outside the workspace (or no workspace): just the filename.
      crumbs = [activeTab.path.split(/[\\/]/).pop() ?? activeTab.path];
    }
  }

  return (
    <div className="breadcrumb">
      {workspaceName !== null && (
        <>
          <span className="breadcrumb-crumb breadcrumb-workspace">{workspaceName}</span>
          {crumbs.length > 0 && <span className="breadcrumb-sep">›</span>}
        </>
      )}
      {crumbs.map((c, i) => (
        <span key={`${c}-${i}`} className="breadcrumb-crumb-wrap">
          <span className="breadcrumb-crumb">{c}</span>
          {i < crumbs.length - 1 && <span className="breadcrumb-sep">›</span>}
        </span>
      ))}
      {activeTab.path === null && (
        <span className="breadcrumb-crumb breadcrumb-untitled">Untitled</span>
      )}
      {activeTab.dirty && (
        <span className="breadcrumb-dirty" title="Unsaved changes">●</span>
      )}
    </div>
  );
}
