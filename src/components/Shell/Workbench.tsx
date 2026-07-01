import { useEffect } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { Sidebar } from "../Sidebar/Sidebar";
import { EditorArea } from "./EditorArea";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { getByPath } from "../../hooks/useSetting";

/**
 * One-shot guard for the window-settings seed. Module-scoped (not a ref) so it
 * survives React 18 StrictMode's mount→unmount→remount in dev, which would
 * otherwise run the effect twice and could overwrite an in-flight user toggle.
 */
let windowSettingsSeeded = false;

/**
 * The main workbench: a horizontal split between the workspace sidebar (left)
 * and the editor area (right). Both panes are resizable; the sidebar can be
 * collapsed to near-zero. This replaces the old single-split App layout.
 */
export function Workbench() {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const setSidebar = useUiStore((s) => s.setSidebar);
  const setPreview = useUiStore((s) => s.setPreview);

  // The sidebar shows whenever the user hasn't hidden it (View → Toggle
  // Sidebar / Cmd+B). With no workspace open it renders the EmptyWorkspace
  // prompt (the Open Folder entry point) — so first-run users always see it.
  const showSidebar = sidebarVisible;

  // On first mount, hydrate any workspace the backend already has open (e.g.
  // across a dev reload). Safe to call repeatedly — it's a read-then-load.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Seed the ephemeral pane-visibility state from the persisted `window.*`
  // settings exactly once. This is a STARTUP-ONLY read (non-reactive): the
  // user's in-session toggles keep mutating uiStore and are NOT written back
  // to settings. We `await hydrate()` first because main.tsx kicks off
  // hydration fire-and-forget and Workbench can mount before the store's data
  // is populated; `hydrate` is idempotent, so re-awaiting it here is safe and
  // guarantees a populated read. The module flag makes it idempotent across
  // StrictMode double-invocation.
  useEffect(() => {
    if (windowSettingsSeeded) return;
    windowSettingsSeeded = true;
    void (async () => {
      await useSettingsStore.getState().hydrate();
      const sidebar = getByPath(
        useSettingsStore.getState().data,
        "window.sidebarVisible",
      ) as boolean | undefined;
      const preview = getByPath(
        useSettingsStore.getState().data,
        "window.previewVisible",
      ) as boolean | undefined;
      setSidebar(sidebar ?? true);
      setPreview(preview ?? true);
    })();
  }, [setSidebar, setPreview]);

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
