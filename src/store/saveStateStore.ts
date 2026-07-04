import { create } from "zustand";
import type { DocumentId, SaveState } from "../lib/types";

/**
 * Per-document save state mirror (§5.3).
 *
 * The backend `SaveCoordinator` is the source of truth for each document's
 * `SaveState` (`idle` / `saving` / `saved` / `failed`). It emits
 * `save_state_changed` on every transition; this store subscribes (see
 * `onSaveStateChanged` in `tauri.ts`) and keeps a normalized map so the status
 * bar can render a saving indicator / red save-failed state without per-event
 * prop drilling.
 *
 * The store is intentionally minimal — it only mirrors state. The full
 * save-failure UI (retry / Save As / open-dir / copy-details) reads the active
 * document's state from here.
 */
export interface SaveStateStore {
  /** DocumentId → current SaveState. Absent ≡ "idle". */
  byDoc: Record<string, SaveState>;
  /** Apply a state-change event for `id`. */
  setSaveState: (id: DocumentId, state: SaveState) => void;
  /** Read-only lookup (defaults to `{ kind: "idle" }` when untracked). */
  getSaveState: (id: DocumentId) => SaveState;
  /** Remove a document's entry (on close). */
  clear: (id: DocumentId) => void;
}

/** The idle default for an untracked document. */
export const IDLE_SAVE_STATE: SaveState = "idle";

export const useSaveStateStore = create<SaveStateStore>()((set, get) => ({
  byDoc: {},

  setSaveState: (id, state) =>
    set((s) => ({ byDoc: { ...s.byDoc, [id]: state } })),

  getSaveState: (id) => get().byDoc[id] ?? IDLE_SAVE_STATE,

  clear: (id) =>
    set((s) => {
      if (!(id in s.byDoc)) return s;
      const next = { ...s.byDoc };
      delete next[id];
      return { byDoc: next };
    }),
}));
