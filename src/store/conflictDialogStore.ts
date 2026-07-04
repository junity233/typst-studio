import { create } from "zustand";

/**
 * Conflict-resolution dialog state (§5.4).
 *
 * The dialog targets a SINGLE conflicted document at a time — the one the user
 * tried to save (the SaveCoordinator gate rejected the in-place save with
 * `ExternalConflict` and the frontend's `saveTab` opened this dialog instead of
 * alerting), or the one clicked from the StatusBar's "Conflict" entry. The
 * dialog reads the doc's `conflict` + `conflictDiskContent` from
 * `documentsStore` (not duplicated here) and renders the matching actions.
 *
 * The store itself only tracks WHICH doc's dialog is open (and a transient
 * action error string); all conflict state lives on the document.
 */

export interface ConflictDialogState {
  /** The document id whose conflict dialog is open, or null when closed. */
  openForId: string | null;
  /**
   * Transient error from the last resolution action (use-disk / overwrite /
   * save-as). Surfaced in the dialog so a failed overwrite, say, doesn't
   * silently swallow the error. Cleared on a successful action or on open.
   */
  error: string | null;
  /** Open the dialog for `id` (clearing any prior error). */
  open: (id: string) => void;
  /** Close the dialog (the "Later" path — the conflict itself is unchanged). */
  close: () => void;
  /** Record an action error (keeps the dialog open so the user can retry). */
  setError: (message: string | null) => void;
}

export const useConflictDialogStore = create<ConflictDialogState>()((set) => ({
  openForId: null,
  error: null,

  open: (id) => set({ openForId: id, error: null }),
  close: () => set({ openForId: null, error: null }),
  setError: (message) => set({ error: message }),
}));
