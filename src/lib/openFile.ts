import { useTabsStore, readOrderedDocuments } from "../store/tabsStore";
import { openFileByPath } from "./tauri";
import { toIpcError } from "./ipc-error";

/**
 * Open a workspace file: activate its tab if already open, else open a new one.
 * Extracted from Explorer.handleDoubleClick so the Search panel can reuse it.
 *
 * `absPath` must be absolute. Errors are surfaced via `window.alert` (matching
 * Explorer's behavior); a Cancelled IPC code is silent.
 */
export async function openFile(absPath: string): Promise<void> {
  try {
    const existing = readOrderedDocuments().find((t) => t.path === absPath);
    if (existing) {
      useTabsStore.getState().activate(existing.id);
      return;
    }
    const doc = await openFileByPath(absPath);
    useTabsStore.getState().openPath(doc);
  } catch (e) {
    const ipc = toIpcError(e);
    if (ipc.code === "cancelled") return;
    window.alert(`Could not open: ${ipc.message}`);
  }
}
