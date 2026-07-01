import { useEffect } from "react";
import { Allotment } from "allotment";
import { Sidebar } from "../Sidebar/Sidebar";
import { EditorArea } from "./EditorArea";
import { useWorkspaceStore } from "../../store/workspaceStore";

/**
 * The main workbench: a horizontal split between the workspace sidebar (left)
 * and the editor area (right). Both panes are resizable; the sidebar can be
 * collapsed to near-zero. This replaces the old single-split App layout.
 */
export function Workbench() {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  // On first mount, hydrate any workspace the backend already has open (e.g.
  // across a dev reload). Safe to call repeatedly — it's a read-then-load.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="workbench">
      <Allotment proportionalLayout={false}>
        {/* Sidebar: hidden (min 0) when no workspace is open, else 220–480px. */}
        <Allotment.Pane
          minSize={rootPath === null ? 0 : 0}
          preferredSize={rootPath === null ? 0 : 220}
          maxSize={rootPath === null ? 0 : 520}
          visible={rootPath !== null}
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
