import { create } from "zustand";
import type { Diagnostic } from "../lib/types";

/**
 * The two diagnostic sources surfaced in the Problems UI (spec §13.1).
 *
 * - `compiler` — diagnostics from the built-in Typst compile pipeline
 *   (`diagnostics` event), aligned to the backend revision.
 * - `tinymist` — diagnostics mirrored out of Monaco's marker service
 *   (`publishDiagnostics` → markers → [`lspDiagnosticsBridge`](../components/Editor/lspDiagnosticsBridge.ts)),
 *   aligned to the LSP generation + URI.
 *
 * The two coexist per document and must NOT overwrite each other (§13.1
 * "两者可以同时展示，不能互相覆盖"). UI-layer dedup is permitted but must
 * preserve the source tag.
 */
export type DiagnosticSource = "compiler" | "tinymist";

/**
 * Per-document diagnostics split by source (spec §13.1). Both arrays are held
 * independently so a new tinymist publish does not clobber the compiler set
 * (and vice versa).
 */
export interface DocDiagnostics {
  compiler: Diagnostic[];
  tinymist: Diagnostic[];
}

/** Stable empty array shared by [`getCombined`] / the selectors. */
const EMPTY: Diagnostic[] = Object.freeze([]) as unknown as Diagnostic[];

/**
 * Read-only combined view: the concatenation of both sources for one document
 * (spec §13.1). UI-layer dedup is optional and left to the consumer. Returns a
 * stable empty array reference when the doc has no diagnostics recorded so
 * reference-equality selectors don't churn on every render.
 */
export function getCombined(
  doc: DocDiagnostics | undefined,
): Diagnostic[] {
  if (doc === undefined) return EMPTY;
  if (doc.compiler.length === 0) return doc.tinymist;
  if (doc.tinymist.length === 0) return doc.compiler;
  return [...doc.compiler, ...doc.tinymist];
}

/**
 * Pure selector: read one source, or the combined view, for a document slot.
 * Exported separately (spec §17 testing seam) so the bridge and store can share
 * one implementation and the unit tests can exercise it without the store.
 *
 * - `source === undefined` → combined (compiler + tinymist).
 * - `source === "compiler" | "tinymist"` → just that source's array.
 *
 * Always returns an array (never `undefined`); returns the stable `EMPTY`
 * reference when the slot is absent or the requested source is empty.
 */
export function selectDiagnosticsForDoc(
  doc: DocDiagnostics | undefined,
  source?: DiagnosticSource,
): Diagnostic[] {
  if (doc === undefined) return EMPTY;
  if (source === undefined) return getCombined(doc);
  const arr = doc[source];
  return arr.length > 0 ? arr : EMPTY;
}

export interface DiagsState {
  /**
   * Per-document, per-source diagnostics (spec §13.1). Keyed by `DocumentId`.
   * An entry is created lazily on the first `set` and removed by `clearAll`.
   */
  byDoc: Record<string, DocDiagnostics>;
  /**
   * Replace ONE source for ONE document (spec §13.1). The other source is
   * left untouched. Used by the diagnostics bridge (tinymist) and the compile
   * diagnostics listener (compiler, Task 11).
   */
  set: (id: string, source: DiagnosticSource, diags: Diagnostic[]) => void;
  /**
   * Clear ONE source for ONE document — e.g. on doc close for that source, or
   * the generation-change stale-tinymist clear in the bridge (§13.2).
   */
  clear: (id: string, source: DiagnosticSource) => void;
  /**
   * Clear BOTH sources for ONE document. Used by `tabsStore.closeTab` so a
   * closed tab drops every source at once.
   */
  clearAll: (id: string) => void;
}

export const useDiagnosticsStore = create<DiagsState>()((set) => ({
  byDoc: {},
  set: (id, source, diags) =>
    set((s) => {
      const prev = s.byDoc[id];
      // Reuse the other source's array reference when unchanged so
      // memoized selectors downstream keep their referential stability.
      const next: DocDiagnostics =
        prev === undefined
          ? { compiler: [], tinymist: [] }
          : prev;
      return {
        byDoc: {
          ...s.byDoc,
          [id]: { ...next, [source]: diags },
        },
      };
    }),
  clear: (id, source) =>
    set((s) => {
      const prev = s.byDoc[id];
      if (prev === undefined) return s;
      // If both sources are already empty, drop the entry entirely so the
      // store doesn't accumulate empty slots for closed docs.
      const cleared: DocDiagnostics = { ...prev, [source]: [] };
      if (cleared.compiler.length === 0 && cleared.tinymist.length === 0) {
        const next = { ...s.byDoc };
        delete next[id];
        return { byDoc: next };
      }
      return { byDoc: { ...s.byDoc, [id]: cleared } };
    }),
  clearAll: (id) =>
    set((s) => {
      if (!(id in s.byDoc)) return s;
      const next = { ...s.byDoc };
      delete next[id];
      return { byDoc: next };
    }),
}));

/**
 * Backward-compatible combined-diagnostics selector (spec §13.1 / §17).
 *
 * `DiagnosticsPanel` / `StatusBar` previously read a flat `byTab[id]` array.
 * With the per-source split they now read the COMBINED view (compiler + tinymist
 * concatenated). This hook returns that combined array for `id` (or an empty
 * array when `id` is null or the doc has no diagnostics), keeping the consumer
 * sites unchanged. UI-layer dedup is the consumer's call (§13.1).
 *
 * The underlying selector returns the stable `EMPTY` reference when nothing is
 * recorded, so referential-equality consumers don't re-render on unrelated
 * store transitions.
 */
export function useDiagnosticsForDoc(id: string | null | undefined): Diagnostic[] {
  return useDiagnosticsStore((s) =>
    id === null || id === undefined
      ? EMPTY
      : selectDiagnosticsForDoc(s.byDoc[id]),
  );
}
