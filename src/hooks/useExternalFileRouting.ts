import { useEffect } from "react";
import { onFocusView, onOpenExternalFile, openFileByPath } from "../lib/tauri";
import { useTabsStore } from "../store/tabsStore";

/**
 * Single-instance file routing (§6.1). Mounted once at the app root.
 *
 * When a second app instance launches (or the user double-clicks a `.typ` file
 * while the app is already running), the backend's single-instance plugin
 * callback emits one of two events:
 *
 * - `focus_view`: the file is already open — activate its tab.
 * - `open_external_file`: the file is not open — open a new tab via the existing
 *   `openFileByPath` flow, exactly as a file-tree click does.
 *
 * The window is brought to front by the backend; this hook only handles tab
 * activation/opening.
 */
export function useExternalFileRouting(): void {
  useEffect(() => {
    const unlisteners: Array<(() => void) | undefined> = [];

    onFocusView((payload) => {
      useTabsStore.getState().activate(payload.id);
    }).then((fn) => unlisteners.push(fn));

    onOpenExternalFile(async (payload) => {
      try {
        const doc = await openFileByPath(payload.path);
        useTabsStore.getState().openPath(doc);
      } catch (e) {
        console.error("[useExternalFileRouting] open failed:", e);
      }
    }).then((fn) => unlisteners.push(fn));

    return () => {
      for (const unlisten of unlisteners) unlisten?.();
    };
  }, []);
}
