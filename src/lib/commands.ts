import { saveFile, saveAs as saveAsBE } from "./tauri";
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
    // choice === "discard" → proceed to close without saving.
  }

  await useTabsStore.getState().closeTab(id);
  return true;
}
