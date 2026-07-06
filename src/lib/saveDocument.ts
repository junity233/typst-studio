import { useDocumentsStore } from "../store/documentsStore";
import { saveAs, saveFile, updateText } from "./tauri";

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
  return { ...snapshot, path: snapshot.path };
}

/** Flush the live buffer, then run Save As and return the chosen path. */
export async function flushAndSaveAs(
  id: string,
): Promise<FlushedDocumentSnapshot & { path: string }> {
  const snapshot = await flushDocumentSnapshot(id);
  const path = await saveAs(id);
  return { ...snapshot, path };
}
