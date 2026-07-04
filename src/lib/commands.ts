import { saveFile, saveAs as saveAsBE, discardRecovery } from "./tauri";
import { useTabsStore } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useDialogStore } from "../store/dialogStore";

/**
 * Save a single tab: Save As if untitled, save in place if titled. Returns
 * true on success, false on failure or user cancel (and alerts the user on
 * error). Shared by the per-tab close guard and the app-wide Save-All guard.
 */
export async function saveTab(id: string): Promise<boolean> {
  const tab = useDocumentsStore.getState().documents[id] ?? null;
  if (tab === null) return false;
  try {
    if (tab.path === null) {
      const path = await saveAsBE(id);
      useTabsStore.getState().markSaved(id, path);
    } else {
      await saveFile(id);
      useTabsStore.getState().markSaved(id, tab.path);
    }
    return true;
  } catch (e) {
    window.alert(`Save failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Close a tab, prompting to save first if it has unsaved changes.
 *
 *   - Untitled dirty tab: prompt → Save (Save As) / Don't Save / Cancel
 *   - Titled dirty tab:   prompt → Save (in place) / Don't Save / Cancel
 *   - Clean tab:          close immediately
 *
 * Returns true if the tab was closed, false if cancelled.
 *
 * Crash recovery (§5.1.4): on "Don't Save", the recovery snapshot for this doc
 * is discarded so its content is NOT offered again on the next launch. The
 * discard is best-effort (a failure is logged but does not block the close);
 * the backend `discard_recovery` is idempotent for ids with no snapshot.
 */
export async function closeTabWithConfirm(id: string): Promise<boolean> {
  const tab = useDocumentsStore.getState().documents[id] ?? null;
  if (tab === null) return false;

  if (tab.dirty) {
    const name = tab.title;
    const choice = await useDialogStore.getState().confirm({
      title: `Save changes to "${name}"?`,
      message: "Your changes will be lost if you don't save them.",
      confirmLabel: "Save",
      discardLabel: "Don't Save",
      cancelLabel: "Cancel",
    });
    if (choice === "cancel") return false;
    if (choice === "confirm") {
      if (!(await saveTab(id))) return false;
    }
    if (choice === "discard") {
      // §5.1.4: the user explicitly discarded this doc's unsaved changes —
      // delete its recovery snapshot so it isn't offered next launch.
      try {
        await discardRecovery(id);
      } catch (e) {
        console.warn(`[closeTabWithConfirm] discard_recovery failed for ${id}:`, e);
      }
    }
  }

  await useTabsStore.getState().closeTab(id);
  return true;
}
