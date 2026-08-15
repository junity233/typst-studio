import { onFocusView, onOpenExternalFile, openFileByPath } from "../lib/tauri";
import { useTabsStore, readAllDocuments } from "../store/tabsStore";
import { isCancelled, alertIpcError } from "../lib/ipc-error";
import { useTauriListener } from "./useTauriListener";

/**
 * Single-instance file routing (§6.1). Mounted once at the app root.
 *
 * When a second app instance launches (or the user double-clicks a `.typ` file
 * while the app is already running), the backend's single-instance plugin
 * callback emits one of two events:
 *
 * - `focus_view`: the file is already open — activate its tab (re-activating
 *   it if the doc was soft-closed/hidden).
 * - `open_external_file`: the file is not open — open a new tab via the existing
 *   `openFileByPath` flow, exactly as a file-tree click does.
 *
 * The window is brought to front by the backend; this hook only handles tab
 * activation/opening.
 */
export function useExternalFileRouting(): void {
  useTauriListener(onFocusView, (payload) => {
    // The backend's document registry includes soft-closed (hidden) docs;
    // `activate` only works for ids on the visible tab strip, so re-activate
    // hidden docs instead (mirrors openFile.ts).
    const doc = readAllDocuments().find((d) => d.id === payload.id);
    if (doc?.hidden) {
      void useTabsStore.getState().reactivate(payload.id);
    } else {
      useTabsStore.getState().activate(payload.id);
    }
  });

  useTauriListener(onOpenExternalFile, async (payload) => {
    try {
      const doc = await openFileByPath(payload.path);
      useTabsStore.getState().openPath(doc);
    } catch (e) {
      // Surface failures to the user instead of silently dropping them —
      // every other open path (openFile.ts, Explorer) alerts on failure, and
      // a silent "double-click did nothing" is the worst UX here. A Cancelled
      // IPC code stays silent (matches openFile.ts).
      if (isCancelled(e)) return;
      alertIpcError("couldNotOpen", e);
    }
  });
}
