import { create } from "zustand";
import type { RecoverableInfo } from "../lib/types";

/**
 * Crash-recovery UI state (§5.1.3).
 *
 * The backend emits `recovery_available` once at startup when recoverable
 * snapshots exist. This store holds the recoverable list + dialog visibility.
 * The `RecoveryDialog` reads from it; per-doc decisions (recover / compare /
 * discard) are driven by the actions here and resolve each entry, so once
 * every snapshot is decided the dialog auto-closes and the normal session
 * restore proceeds.
 *
 * `decidedIds` tracks which snapshots the user has acted on, so the dialog can
 * show a "remaining: N" hint and auto-dismiss when all are handled.
 * `comparedIds` tracks which disk-changed snapshots the user has Compare'd
 * (§5.1.3): Recover is disabled for a disk-changed doc until the user views
 * both versions, after which the id lands here and Recover enables.
 */

/** A per-doc decision the user can make in the recovery dialog. */
export type RecoveryDecision = "recover" | "compare" | "discard";

/**
 * §5.1.3 decision matrix: whether a snapshot's Recover action must be gated
 * behind a Compare first. A disk-changed doc (one with a canonical path whose
 * on-disk bytes differ from the snapshot) requires the user to view both
 * versions before Recover is enabled — UNLESS the user has already compared
 * (`compared` true), in which case the requirement is satisfied. Untitled docs
 * and unchanged docs never require a compare.
 *
 * Pure + exported so the dialog and its test share ONE definition of the
 * intent (a regression in either the gating flag or the compare-unlock is
 * caught by the test).
 *
 * @param snapshot  the recoverable doc
 * @param compared  whether the user has already Compare'd this doc
 */
export function recoverRequiresCompareFirst(
  snapshot: RecoverableInfo,
  compared: boolean,
): boolean {
  const isUntitled =
    snapshot.canonicalPath === undefined || snapshot.canonicalPath === null;
  return !isUntitled && snapshot.diskChanged && !compared;
}

export interface RecoveryState {
  /** Snapshots offered for recovery (from the `recovery_available` event). */
  recoverable: RecoverableInfo[];
  /** Whether the recovery dialog is currently shown. */
  dialogOpen: boolean;
  /** Snapshot ids the user has already decided on (recover / discard). */
  decidedIds: Set<string>;
  /**
   * Snapshot ids the user has already Compare'd (§5.1.3). A disk-changed doc's
   * Recover button is disabled until the user has viewed both versions; once an
   * id is in this set, its effective `mustCompare` is false and Recover becomes
   * available. Lifted into the store (rather than per-row local state) so it
   * survives re-renders and is unit-testable without rendering the dialog.
   */
  comparedIds: Set<string>;
  /** Populate the list from the startup event and open the dialog. */
  offerRecovery: (snapshots: RecoverableInfo[]) => void;
  /** Mark a snapshot decided (removes it from the "remaining" count). */
  markDecided: (id: string) => void;
  /** Mark a snapshot compared (enables Recover for disk-changed docs). */
  markCompared: (id: string) => void;
  /** Whether `id` has been compared (Recover-enablement for disk-changed docs). */
  hasCompared: (id: string) => boolean;
  /** Close the dialog once every snapshot has been handled. */
  closeIfAllDecided: () => void;
  /** Force-close the dialog (e.g. user dismissed via overlay / Esc). */
  close: () => void;
  /** Reset to the empty state (for tests). */
  reset: () => void;
}

export const useRecoveryStore = create<RecoveryState>()((set, get) => ({
  recoverable: [],
  dialogOpen: false,
  decidedIds: new Set(),
  comparedIds: new Set(),

  offerRecovery: (snapshots) =>
    set({
      recoverable: snapshots,
      dialogOpen: snapshots.length > 0,
      decidedIds: new Set(),
      comparedIds: new Set(),
    }),

  markDecided: (id) => {
    set((s) => {
      const next = new Set(s.decidedIds);
      next.add(id);
      return { decidedIds: next };
    });
    // Auto-close once every snapshot is decided.
    get().closeIfAllDecided();
  },

  markCompared: (id) => {
    set((s) => {
      const next = new Set(s.comparedIds);
      next.add(id);
      return { comparedIds: next };
    });
  },

  hasCompared: (id) => get().comparedIds.has(id),

  closeIfAllDecided: () => {
    const { recoverable, decidedIds } = get();
    if (recoverable.length > 0 && decidedIds.size >= recoverable.length) {
      set({ dialogOpen: false });
    }
  },

  close: () => set({ dialogOpen: false }),

  reset: () =>
    set({
      recoverable: [],
      dialogOpen: false,
      decidedIds: new Set(),
      comparedIds: new Set(),
    }),
}));
