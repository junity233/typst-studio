import { create } from "zustand";
import {
  exportBatchPdf,
  hardCloseTab,
  listTypstFiles,
  openFileByPath,
} from "../lib/tauri";
import type { BatchExportOutcome, TypstFileEntry } from "../lib/types";
import { toIpcError } from "../lib/ipc-error";
import { flushDocumentSnapshot } from "../lib/saveDocument";
import { findOpenDocByPath } from "./documentsStore";
import { useTabsStore } from "./tabsStore";

/**
 * Batch-export dialog state: the workspace `.typ` listing, the user's
 * selection, and the export run's progress/results.
 *
 * ## Closed-file handling
 *
 * Export is tab-bound (DocumentId + pinned revision, §9). For a file that
 * isn't open, we open a BACKEND-only tab (`openFileByPath` without adding it
 * to the frontend tab strip — the frontend drives tab-bar membership via
 * `tabsStore.openPath`, which we deliberately skip), export revision 0 (the
 * backend's `doc_for_revision` poller waits out its initial compile), then
 * hard-close the tab so no state lingers. Files that were already open keep
 * their tabs and export their flushed revision.
 */
type BatchPhase = "loading" | "picking" | "exporting" | "done";

interface BatchExportState {
  open: boolean;
  phase: BatchPhase;
  files: TypstFileEntry[];
  selected: Set<string>;
  results: BatchExportOutcome[] | null;
  error: string | null;
  /** Load the listing and open the dialog (command palette entry point). */
  openDialog: () => Promise<void>;
  close: () => void;
  toggle: (absPath: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  /** Export the selection — the backend shows the folder picker itself. */
  run: () => Promise<void>;
}

/** File stem of a path ("/a/b/notes.typ" → "notes"; "" → "document"). */
function fileStem(absPath: string): string {
  const base = absPath.replace(/[\\/]/g, "/").split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem === "" ? "document" : stem;
}

/**
 * Uniquify stems for output naming: two files named `main.typ` in different
 * directories would otherwise overwrite each other's `main.pdf` — and so
 * would a REAL `main-2.typ` colliding with the generated `main-2` from the
 * second `main.typ`. Names are therefore assigned against a used-set and
 * bumped to a fixpoint (`main`, `main-2`, `main-2` → `main-2-2`, …). The
 * backend re-deduplicates after sanitization (its rules can still merge two
 * distinct names); this pass keeps the preview honest.
 */
export function uniquifyStems(absPaths: string[]): { abs: string; name: string }[] {
  const used = new Set<string>();
  return absPaths.map((abs) => {
    const stem = fileStem(abs);
    if (!used.has(stem)) {
      used.add(stem);
      return { abs, name: stem };
    }
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return { abs, name: candidate };
      }
    }
  });
}

export const useBatchExportStore = create<BatchExportState>()((set, get) => ({
  open: false,
  phase: "loading",
  files: [],
  selected: new Set(),
  results: null,
  error: null,

  openDialog: async () => {
    set({ open: true, phase: "loading", files: [], selected: new Set(), results: null, error: null });
    try {
      const files = await listTypstFiles();
      // A stale close() while loading must not clobber the fresh open.
      if (!get().open) return;
      set({ files, phase: "picking" });
    } catch (e) {
      // Backend rejections arrive as serialized IpcError objects, not Error —
      // toIpcError extracts the message (String(e) would be "[object Object]").
      set({ phase: "picking", error: toIpcError(e).message });
    }
  },

  close: () =>
    set({ open: false, phase: "loading", files: [], selected: new Set(), results: null, error: null }),

  toggle: (absPath) =>
    set((s) => {
      const selected = new Set(s.selected);
      if (selected.has(absPath)) selected.delete(absPath);
      else selected.add(absPath);
      return { selected };
    }),

  selectAll: () => set((s) => ({ selected: new Set(s.files.map((f) => f.absPath)) })),
  clearSelection: () => set({ selected: new Set() }),

  run: async () => {
    set({ phase: "exporting", error: null, results: null });
    const picked = uniquifyStems([...get().selected]);
    const items: { id: string; revision: number; name: string }[] = [];
    // Backend-only tabs we opened for this run and must close afterwards.
    const closeAfterwards: string[] = [];
    try {
      const tabs = useTabsStore.getState();
      const knownIds = new Set([...tabs.tabs, ...tabs.hidden]);
      for (const { abs, name } of picked) {
        const openDoc = findOpenDocByPath(abs);
        if (openDoc !== undefined) {
          const snapshot = await flushDocumentSnapshot(openDoc.id);
          items.push({ id: openDoc.id, revision: snapshot.revision, name });
          continue;
        }
        // Closed file: backend-only tab at revision 0. The backend's export
        // poller waits for the initial compile (bounded by export.revisionWaitMs).
        const doc = await openFileByPath(abs);
        items.push({ id: doc.id, revision: 0, name });
        if (!knownIds.has(doc.id)) closeAfterwards.push(doc.id);
      }
      // The backend shows the folder picker itself (same trust model as the
      // single-export save dialog) and returns per-item outcomes.
      const results = await exportBatchPdf(items);
      set({ phase: "done", results });
    } catch (e) {
      // A cancelled folder pick is a silent return to picking, not an error.
      // The backend signals it via IpcError code "cancelled" (§5.3) — the
      // serialized object is narrowed by toIpcError, never stringified.
      const ipc = toIpcError(e);
      if (ipc.code === "cancelled") {
        set({ phase: "picking" });
      } else {
        set({ phase: "picking", error: ipc.message });
      }
    } finally {
      // Release the backend-only tabs regardless of outcome. Best-effort: a
      // failed close leaves a hidden tab, which the LRU eviction will reap.
      for (const id of closeAfterwards) {
        void hardCloseTab(id).catch(() => {});
      }
    }
  },
}));
