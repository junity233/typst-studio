import { saveFile, saveAs as saveAsBE, discardRecovery } from "./tauri";
import { useTabsStore } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useDialogStore } from "../store/dialogStore";
import { useConflictDialogStore } from "../store/conflictDialogStore";
import {
  formatSaveErrorMessage,
  isCancelled,
  SAVE_AS_RECOVERY_CODES,
  toIpcError,
} from "./ipc-error";

/**
 * Save a single tab: Save As if untitled, save in place if titled. Returns
 * true on success, false on failure or user cancel (and alerts the user on
 * error). Shared by the per-tab close guard and the app-wide Save-All guard.
 *
 * §5.3 structured errors: the backend rejects with an `IpcError` carrying a
 * stable `code`. We branch on it: `Cancelled` is silent (not a failure); for
 * permission/readonly/path-occupied codes we offer Save As; for the rest we
 * show a code-specific message instead of the old generic "Save failed: …".
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
    // §5.3: Cancelled is not a failure — silent no-op.
    if (isCancelled(e)) {
      return false;
    }
    const err = toIpcError(e);
    // §5.4 conflict gate: the in-place save was blocked because the doc is in
    // conflict. Open the conflict-resolution UI instead of alerting (the user
    // must choose use-disk / overwrite / save-as / later — Save As is one of
    // those actions, surfaced inside the dialog). The conflict state itself
    // stays set (the doc is still conflicted); the gate keeps blocking until a
    // resolution action clears it.
    if (err.code === "external_conflict") {
      useConflictDialogStore.getState().open(id);
      return false;
    }
    // For permission/readonly/path-occupied codes, offer Save As first.
    if (SAVE_AS_RECOVERY_CODES.has(err.code) && tab.path !== null) {
      const choice = await useDialogStore.getState().confirm({
        title: "Save failed",
        message: `${formatSaveErrorMessage(e)}\n\nSave as a new file instead?`,
        confirmLabel: "Save As…",
        cancelLabel: "Cancel",
      });
      if (choice === "confirm") {
        try {
          const path = await saveAsBE(id);
          useTabsStore.getState().markSaved(id, path);
          return true;
        } catch (e2) {
          if (!isCancelled(e2)) {
            window.alert(formatSaveErrorMessage(e2));
          }
          return false;
        }
      }
      return false;
    }
    // Disk-full / transient / other: show the code-specific message.
    const msg = formatSaveErrorMessage(e);
    if (msg) {
      window.alert(msg);
    }
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
