import { useEffect } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { Sidebar } from "../Sidebar/Sidebar";
import { EditorArea } from "./EditorArea";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";

/**
 * The main workbench: a horizontal split between the workspace sidebar (left)
 * and the editor area (right). Both panes are resizable; the sidebar can be
 * collapsed to near-zero. This replaces the old single-split App layout.
 */
export function Workbench() {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);

  // The sidebar shows whenever the user hasn't hidden it (View → Toggle
  // Sidebar / Cmd+B). With no workspace open it renders the EmptyWorkspace
  // prompt (the Open Folder entry point) — so first-run users always see it.
  const showSidebar = sidebarVisible;

  // On first mount, hydrate any workspace the backend already has open (e.g.
  // across a dev reload). Safe to call repeatedly — it's a read-then-load.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="workbench">
      <Allotment proportionalLayout={false}>
        {/* Sidebar: hidden when no workspace or toggled off; else 220–520px. */}
        <Allotment.Pane
          minSize={0}
          preferredSize={showSidebar ? 220 : 0}
          maxSize={showSidebar ? 520 : 0}
          visible={showSidebar}
          snap
        >
          <Sidebar />
        </Allotment.Pane>
        <Allotment.Pane minSize={320}>
          <EditorArea />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}
