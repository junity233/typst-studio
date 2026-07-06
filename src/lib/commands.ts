import { discardRecovery } from "./tauri";
import { flushAndSaveAs, flushAndSaveInPlace } from "./saveDocument";
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
import i18n from "../i18n";

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
      const saved = await flushAndSaveAs(id);
      useTabsStore.getState().markSaved(id, saved.path, saved.revision);
    } else {
      const saved = await flushAndSaveInPlace(id);
      useTabsStore.getState().markSaved(id, saved.path, saved.revision);
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
        title: i18n.t("saveFailed.title", { ns: "dialog" }),
        message: i18n.t("saveFailed.saveAsInstead", {
          ns: "dialog",
          reason: formatSaveErrorMessage(e),
        }),
        confirmLabel: i18n.t("saveAs", { ns: "common" }),
        cancelLabel: i18n.t("cancel", { ns: "common" }),
      });
      if (choice === "confirm") {
        try {
          const saved = await flushAndSaveAs(id);
          useTabsStore.getState().markSaved(id, saved.path, saved.revision);
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
      title: i18n.t("saveChanges.title", { ns: "dialog", name }),
      message: i18n.t("saveChanges.changesWillBeLost", { ns: "dialog" }),
      confirmLabel: i18n.t("save", { ns: "common" }),
      discardLabel: i18n.t("dontSave", { ns: "common" }),
      cancelLabel: i18n.t("cancel", { ns: "common" }),
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
      // The user explicitly threw away unsaved edits — hard-close (destroy) so
      // the dirty content doesn't survive in the soft-close cache. Soft-close
      // is for "I'll come back to this"; discard is "throw it away."
      await useTabsStore.getState().hardClose(id);
      return true;
    }
  }

  // The save and clean-tab paths still use closeTab = soft-close, which keeps
  // the doc alive in the hidden cache for instant reactivation.
  await useTabsStore.getState().closeTab(id);
  return true;
}
