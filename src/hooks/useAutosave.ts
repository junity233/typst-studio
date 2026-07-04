import { useEffect, useRef } from "react";
import { useSetting } from "./useSetting";
import { useDocumentsStore } from "../store/documentsStore";
import { useSaveStateStore } from "../store/saveStateStore";
import { saveFile } from "../lib/tauri";
import { toIpcError } from "../lib/ipc-error";

/**
 * Autosave (§7.1). Three modes, driven by the `autosave.mode` setting:
 *
 *   - `off` (default): no automatic saves.
 *   - `afterDelay`: a debounce timer (default 3s, configurable via
 *     `autosave.delayMs`) fires after the last edit, saving every disk-backed
 *     dirty document. Untitled docs are NOT auto-saved (§7.1 "Untitled 不自动
 *     弹出 Save As").
 *   - `onFocusChange`: on the main window losing focus, save every disk-backed
 *     dirty document (§7.1 "编辑器失焦时保存").
 *
 * ## Suspension rules (§7.1)
 *
 * Autosave is SUSPENDED (the doc is skipped, NOT errored) when:
 *   - the doc has no path (Untitled) — never auto-prompt Save As;
 *   - the doc is in a conflict (the in-place save is gated — §5.4 — the user
 *     must resolve first);
 *   - the doc's last save failed (dirty stays; let the user retry/Save As from
 *     the status bar — don't hammer a failing write).
 *
 * Recovery snapshots are NOT affected by the autosave setting (§7.1 "恢复快照
 * 不受自动保存开关影响") — they keep running unconditionally via the backend.
 *
 * ## No success toast (§7.1)
 *
 * On a successful autosave we do NOT show a toast; the status bar's saving /
 * saved state (mirrored from `save_state_changed`) is the only signal. A
 * failure is also non-modal (the status bar shows the red save-failed state);
 * we do not alert on autosave failure.
 *
 * ## Approach: frontend hook
 *
 * The frontend knows edit timing (the document store's revision bumps) and
 * reads the live settings, so driving autosave from a hook is simpler wiring
 * than a backend timer. The save itself reuses the backend `SaveCoordinator`
 * (via `saveFile`) + `AtomicFileWriter`, so the §5.2 protocol is unchanged.
 */

/** The autosave mode setting (§7.1). */
export type AutosaveMode = "off" | "afterDelay" | "onFocusChange";

/**
 * The docs an autosave pass should attempt. Pure over the injected snapshot so
 * the selection logic is unit-testable without the stores. Returns only
 * disk-backed, dirty, non-conflicted docs whose last save didn't fail (§7.1
 * suspension rules).
 *
 * @param docs the live document snapshot (id, path, dirty, conflict, saveFailed).
 */
export function selectAutosavable(
  docs: ReadonlyArray<{
    id: string;
    path: string | null;
    dirty: boolean;
    conflict: boolean;
    saveFailed: boolean;
  }>,
): string[] {
  return docs
    .filter(
      (d) =>
        d.path !== null && // Untitled → never autosave (§7.1).
        d.dirty && // Only dirty docs need saving.
        !d.conflict && // Conflict → suspend (§5.4 gate).
        !d.saveFailed, // Prior failure → let the user retry.
    )
    .map((d) => d.id);
}

/**
 * Drive autosave from the `autosave.mode` setting. Mounted once at the app
 * root. Reads the mode + delay reactively; re-arms the debounce/focus listener
 * when they change.
 */
export function useAutosave(): void {
  const [mode] = useSetting<AutosaveMode>("autosave.mode");
  const [delayMs] = useSetting<number>("autosave.delayMs");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveMode = mode ?? "off";
  const effectiveDelay = typeof delayMs === "number" && delayMs >= 500 ? delayMs : 3000;

  // --- afterDelay: debounce-save on every document edit -------------------
  useEffect(() => {
    if (effectiveMode !== "afterDelay") return;
    // Subscribe to document edits. The store bumps a revision on every
    // updateContent; we re-arm the debounce each time it changes. Reading the
    // full revision counter (sum across docs) gives a single signal that fires
    // on any edit.
    let lastRevision = totalRevision();
    const interval = setInterval(() => {
      const rev = totalRevision();
      if (rev === lastRevision) return;
      lastRevision = rev;
      // Edit happened → (re)arm the debounce timer.
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void autosaveDirtyDiskDocs();
      }, effectiveDelay);
    }, 500);
    return () => {
      clearInterval(interval);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [effectiveMode, effectiveDelay]);

  // --- onFocusChange: save on window blur ---------------------------------
  useEffect(() => {
    if (effectiveMode !== "onFocusChange") return;
    const onBlur = () => {
      void autosaveDirtyDiskDocs();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [effectiveMode]);
}

/**
 * Save every disk-backed dirty doc that isn't suspended (§7.1). Best-effort:
 * each save is independent; a failure is logged + the doc's saveFailed flag is
 * surfaced via the `save_state_changed` event the SaveCoordinator already
 * emits (no toast — §7.1 "不弹成功提示"). `saveFile` reuses the §5.2 atomic
 * protocol + the §5.4 conflict gate (a conflicted doc is rejected server-side
 * with `external_conflict`, which we treat as "skip, not a failure").
 */
export async function autosaveDirtyDiskDocs(): Promise<void> {
  const docs = useDocumentsStore.getState().documents;
  const saveState = useSaveStateStore.getState();
  const ids = selectAutosavable(
    Object.values(docs).map((d) => ({
      id: d.id,
      path: d.path,
      dirty: d.dirty,
      conflict: isConflictActive(d),
      saveFailed: isSaveFailed(d.id, saveState.getSaveState(d.id)),
    })),
  );
  await Promise.all(
    ids.map(async (id) => {
      try {
        await saveFile(id);
        const path = useDocumentsStore.getState().documents[id]?.path;
        if (path) {
          // Mirror the saved state locally (the store action clears dirty).
          useDocumentsStore.getState().markSaved(id, path);
        }
      } catch (e) {
        const ipc = toIpcError(e);
        // external_conflict: the doc is conflicted — skip silently (suspension
        // rule). The conflict UI is the user's path forward.
        if (ipc.code === "external_conflict") return;
        // Other failures: log only. The status bar's save-failed state (from
        // save_state_changed) is the non-modal signal (§7.1, §8).
        console.warn(`[autosave] save failed for ${id} (${ipc.code}):`, ipc.message);
      }
    }),
  );
}

/**
 * Sum every document's revision into a single counter, so any edit bumps it.
 * Used as the afterDelay edit signal.
 */
function totalRevision(): number {
  const docs = useDocumentsStore.getState().documents;
  let sum = 0;
  for (const d of Object.values(docs)) sum += d.revision;
  return sum;
}

/**
 * Whether a document is in an active conflict (§5.4). The documentsStore
 * carries a `conflict` field (a string-literal union: `"none"` / `"modified"`
 * / `"missing"` / `"permission_changed"` / `"replaced"`). Any non-`"none"`
 * value means the in-place save is gated and autosave must suspend (§7.1).
 * Kept defensive (unknown shape → false) so a future store change degrades to
 * "save anyway".
 */
function isConflictActive(d: { conflict?: unknown }): boolean {
  const c = d.conflict;
  if (c == null) return false;
  if (typeof c === "string") return c !== "none" && c !== "";
  if (typeof c === "object" && c !== null && "kind" in c) {
    const kind = (c as { kind: string }).kind;
    return kind !== "none" && kind !== "";
  }
  return Boolean(c);
}

/**
 * Whether a document's last save failed (so autosave suspends — §7.1 "save
 * failure 状态下暂停"). Consults the mirrored SaveState from `saveStateStore`.
 * A `failed` state means the last write attempt errored and `dirty` stayed
 * true; we don't re-attempt until the user retries / Save-As (the status bar
 * surfaces the failure non-modally).
 */
function isSaveFailed(_id: string, state: import("../lib/types").SaveState): boolean {
  return typeof state === "object" && state !== null && "failed" in state;
}
