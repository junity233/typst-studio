/**
 * localStorage-backed pane geometry preferences (preview width, sidebar
 * width, diagnostics height). These keys are the LIVE store, written on sash
 * drag; the session-v2 `layout.*` fields are the cross-restart source of
 * truth, seeded into localStorage on startup and captured on close.
 *
 * Keys live here (not at the call sites) because two independent modules read
 * each key: the pane component (restore) and `useAppCommands` (session
 * capture) — duplicating the literal invites drift.
 */

export const PREVIEW_WIDTH_KEY = "ts-preview-width";
export const SIDEBAR_WIDTH_KEY = "ts-sidebar-width";
export const DIAG_HEIGHT_KEY = "ts-diags-height";

/**
 * Restore floor for the preview pane, shared by the EditorArea (restore) and
 * the session capture in `useAppCommands` so the two can't drift.
 */
export const PREVIEW_WIDTH_MIN = 240;

/**
 * Tolerantly parse a persisted number preference: returns the finite numeric
 * value, or `null` when the key is unset, unparsable, or localStorage is
 * unavailable (privacy mode / disabled — getItem can throw). Callers apply
 * their own clamp/default policy on top.
 */
export function readStoredNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    // treat a blocked localStorage as "unset"
  }
  return null;
}
