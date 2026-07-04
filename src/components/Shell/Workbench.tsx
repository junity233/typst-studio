import { useEffect } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { Sidebar } from "../Sidebar/Sidebar";
import { ActivityBar } from "./ActivityBar";
import { EditorArea } from "./EditorArea";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { getByPath } from "../../hooks/useSetting";
import { loadSession } from "../../lib/session";
import { effectiveLayout } from "../../lib/layoutState";

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

  // Seed the ephemeral pane-visibility state from the persisted layout,
  // exactly once. Session v2 `layout` (§7.2) wins when present — it reflects
  // the user's most recent in-session choice. The legacy `window.*` settings
  // remain as the first-run fallback (a fresh install, or a v1 session with no
  // layout field). This is a STARTUP-ONLY read (non-reactive): the user's
  // in-session toggles keep mutating uiStore and are captured back into the
  // session layout on close (see useAppCommands). We `await hydrate()` first
  // because main.tsx kicks off hydration fire-and-forget and Workbench can
  // mount before the store's data is populated; `hydrate` is idempotent, so
  // re-awaiting it here is safe and guarantees a populated read. The module
  // flag makes it idempotent across StrictMode double-invocation.
  useEffect(() => {
    if (windowSettingsSeeded) return;
    windowSettingsSeeded = true;
    void (async () => {
      await useSettingsStore.getState().hydrate();
      // Settings fallback (first-run / v1-session defaults).
      const sidebar = getByPath(
        useSettingsStore.getState().data,
        "window.sidebarVisible",
      ) as boolean | undefined;
      const preview = getByPath(
        useSettingsStore.getState().data,
        "window.previewVisible",
      ) as boolean | undefined;
      // Session v2 layout wins when present (§7.2).
      let sessionSidebar: boolean | undefined;
      let sessionPreview: boolean | undefined;
      try {
        const session = await loadSession();
        if (session.layout) {
          sessionSidebar = session.layout.sidebarVisible;
          sessionPreview = session.layout.previewVisible;
        }
      } catch {
        // loadSession already degrades to empty; ignore.
      }
      const eff = effectiveLayout(
        undefined,
        {
          sidebarVisible: sidebar ?? true,
          previewVisible: preview ?? true,
        },
      );
      setSidebar(sessionSidebar ?? eff.sidebarVisible);
      setPreview(sessionPreview ?? eff.previewVisible);
    })();
  }, [setSidebar, setPreview]);

  return (
    <div className="workbench">
      <ActivityBar />
      <Allotment proportionalLayout={false}>
        {/*
          Sidebar pane. CRITICAL: min/max/preferredSize stay CONSTANT regardless
          of `visible`. Allotment restores a re-shown pane by clamping its
          stashed _cachedVisibleSize against the view's CURRENT min/max — but
          its React effect reconciles `visible` (which restores the size) BEFORE
          it reconciles min/max, so zeroing maxSize on hide makes the restore
          clamp to [0,0]=0 and the pane stays invisible after reopening. Toggling
          only `visible` (with `snap` for drag-to-collapse) is the supported API.
        */}
        <Allotment.Pane
          minSize={0}
          preferredSize={220}
          maxSize={520}
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
