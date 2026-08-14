import { useDocumentsStore } from "../store/documentsStore";
import { readSetting } from "../hooks/useSetting";
import { saveAs, saveFile, updateText } from "./tauri";
import { defaultExportFormat, resolveConfiguredOutputPath, runExport } from "./exportTarget";

/**
 * The exact frontend snapshot flushed immediately before a save starts.
 *
 * Saving is deliberately based on a captured revision. If the user edits again
 * while the write is in flight, callers pass this revision to `markSaved`, whose
 * compare-and-set keeps the newer frontend revision dirty.
 */
export interface FlushedDocumentSnapshot {
  id: string;
  content: string;
  revision: number;
  path: string | null;
}

/** Push the latest frontend buffer to the backend and wait for its revision ACK. */
export async function flushDocumentSnapshot(
  id: string,
): Promise<FlushedDocumentSnapshot> {
  const doc = useDocumentsStore.getState().documents[id];
  if (!doc) {
    throw new Error(`document ${id} is not open`);
  }
  const snapshot: FlushedDocumentSnapshot = {
    id,
    content: doc.content,
    revision: doc.revision,
    path: doc.path,
  };
  await updateText(id, snapshot.content, snapshot.revision);
  return snapshot;
}

/** Flush the live buffer, then save that document in place. */
export async function flushAndSaveInPlace(
  id: string,
): Promise<FlushedDocumentSnapshot & { path: string }> {
  const snapshot = await flushDocumentSnapshot(id);
  if (snapshot.path === null) {
    throw new Error(`document ${id} has no path`);
  }
  await saveFile(id);
  maybeAutoExportAfterSave();
  return { ...snapshot, path: snapshot.path };
}

/** Flush the live buffer, then run Save As and return the chosen path. */
export async function flushAndSaveAs(
  id: string,
): Promise<FlushedDocumentSnapshot & { path: string }> {
  const snapshot = await flushDocumentSnapshot(id);
  const path = await saveAs(id);
  maybeAutoExportAfterSave();
  return { ...snapshot, path };
}

/**
 * Auto-export-on-save (`export.autoOnSave`): after ANY successful save, re-run
 * the project's configured export (format + outputPath from `.typstpro`).
 * Skips silently when the setting is off or no outputPath is configured (the
 * dialog-based flow must never trigger from an automatic path).
 *
 * Coalescing: save BURSTS (autosave over N dirty docs, save-all on close)
 * each call this hook; a trailing-edge debounce (400ms) collapses them into
 * one export of the final state instead of N concurrent renders of the same
 * target. The export itself is fire-and-forget: the save already succeeded,
 * so a failure is logged, never surfaced to the saver. The backend writes
 * atomically, so an app quit mid-export can never leave a truncated PDF.
 *
 * Guarded against re-entrancy: `runExport` flushes its own snapshot via
 * `flushDocumentSnapshot` (no save involved), so no save → export → save loop.
 */
let autoExportTimer: number | null = null;
export function maybeAutoExportAfterSave(): void {
  try {
    if (!readSetting<boolean>("export.autoOnSave", false)) return;
    if (resolveConfiguredOutputPath() === undefined) return;
    if (autoExportTimer !== null) window.clearTimeout(autoExportTimer);
    autoExportTimer = window.setTimeout(() => {
      autoExportTimer = null;
      runExport(defaultExportFormat(), true).catch((e) => {
        console.warn("[auto-export] export-on-save failed:", e);
      });
    }, 400);
  } catch (e) {
    console.warn("[auto-export] skipping (unexpected error):", e);
  }
}
