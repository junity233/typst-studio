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
 *
 * Returns the activated document id, or `null` if the open failed (the user has
 * already been alerted). Callers that need to act on the now-active doc (e.g.
 * the Search panel stashing a pending reveal keyed by doc id) use this; callers
 * that don't can ignore it.
 */
export async function openFile(absPath: string): Promise<string | null> {
  try {
    const existing = readAllDocuments().find((t) => t.path === absPath);
    if (existing) {
      if (existing.hidden) {
        await useTabsStore.getState().reactivate(existing.id);
      } else {
        useTabsStore.getState().activate(existing.id);
      }
      return existing.id;
    }
    const doc = await openFileByPath(absPath);
    useTabsStore.getState().openPath(doc);
    return doc.id;
  } catch (e) {
    const ipc = toIpcError(e);
    if (ipc.code === "cancelled") return null;
    window.alert(i18n.t("couldNotOpen", { ns: "errors", message: ipc.message }));
    return null;
  }
}
