import { useTabsStore, readAllDocuments } from "../store/tabsStore";
import { openFileByPath } from "./tauri";
import { toIpcError } from "./ipc-error";
import i18n from "../i18n";

/**
 * Open a workspace file: activate its tab if already open, else open a new one.
 * Extracted from Explorer.handleDoubleClick so the Search panel can reuse it.
 *
 * Phase B2: a soft-closed (hidden) file counts as "already open" — reopening it
 * re-activates the hidden doc (instant, no reload) instead of opening a dup.
 *
 * `absPath` must be absolute. Errors are surfaced via `window.alert` (matching
 * Explorer's behavior); a Cancelled IPC code is silent.
 */
export async function openFile(absPath: string): Promise<void> {
  try {
    const existing = readAllDocuments().find((t) => t.path === absPath);
    if (existing) {
      if (existing.hidden) {
        await useTabsStore.getState().reactivate(existing.id);
      } else {
        useTabsStore.getState().activate(existing.id);
      }
      return;
    }
    const doc = await openFileByPath(absPath);
    useTabsStore.getState().openPath(doc);
  } catch (e) {
    const ipc = toIpcError(e);
    if (ipc.code === "cancelled") return;
    window.alert(i18n.t("couldNotOpen", { ns: "errors", message: ipc.message }));
  }
}
