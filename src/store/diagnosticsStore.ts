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
 * (and vice versa). `combined` is the DEDUPLICATED concatenation, recomputed on
 * every mutation so selectors can return it by reference (zustand v5 requires
 * `useSyncExternalStore` snapshots to be reference-stable across the same store
 * state, otherwise React enters an infinite render loop).
 */
export interface DocDiagnostics {
  compiler: Diagnostic[];
  tinymist: Diagnostic[];
  /** Dedup'd concatenation of both sources, cached for reference stability. */
  combined: Diagnostic[];
}

/** Stable empty array shared by [`getCombined`] / the selectors. */
const EMPTY: Diagnostic[] = Object.freeze([]) as unknown as Diagnostic[];

/**
 * Build a fresh `DocDiagnostics`, computing the deduplicated `combined` view.
 * Called by every store mutation so `combined` is always consistent with the
 * two source arrays AND reference-stable for a given (compiler, tinymist) pair.
 * Exported so tests can construct `DocDiagnostics` literals without hand-
 * computing `combined`.
 */
export function makeDoc(
  compiler: Diagnostic[],
  tinymist: Diagnostic[],
): DocDiagnostics {
  const combined =
    compiler.length === 0
      ? tinymist
      : tinymist.length === 0
        ? compiler
        : dedupDiagnostics([...compiler, ...tinymist]);
  return { compiler, tinymist, combined };
}

/**
 * Read-only combined view: the cached deduplicated concatenation of both
 * sources (spec §13.1). Both sources are now populated (the `compiler` slot by
 * the `diagnostics` compile event; the `tinymist` slot by the LSP bridge), so
 * the same Typst error — typically reported by BOTH — is collapsed to a single
 * entry. Returns the stable `EMPTY` reference when the doc has no diagnostics
 * recorded so referential-equality selectors don't churn on every render.
 */
export function getCombined(
  doc: DocDiagnostics | undefined,
): Diagnostic[] {
  if (doc === undefined) return EMPTY;
  return doc.combined;
}

/**
 * De-duplicate diagnostics by (severity, range, message) — the same Typst
 * error reported by BOTH the compiler slot and the tinymist slot collapses to a
 * single entry. PURE + unit-tested. Stable: keeps the FIRST occurrence of each
 * key, so compiler-sourced diagnostics (authoritative for the native compile)
 * win over a tinymist duplicate when they precede it in the combined array.
 *
 * The range is compared field-for-field (not by reference) so two structurally-
 * equal ranges from different sources collapse. `code` is intentionally NOT part
 * of the key — the two sources may phrase the same error with different codes,
 * and collapsing on code would leave the duplicate visible.
 */
export function dedupDiagnostics(diags: readonly Diagnostic[]): Diagnostic[] {
  if (diags.length < 2) return [...diags];
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diags) {
    const key = `${d.severity}|${d.range.start_line}:${d.range.start_column}-${d.range.end_line}:${d.range.end_column}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
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
      // Rebuild via makeDoc so the cached `combined` field stays consistent
      // with the new source array (and reference-stable for zustand selectors).
      const compiler = source === "compiler" ? diags : (prev?.compiler ?? []);
      const tinymist = source === "tinymist" ? diags : (prev?.tinymist ?? []);
      return {
        byDoc: {
          ...s.byDoc,
          [id]: makeDoc(compiler, tinymist),
        },
      };
    }),
  clear: (id, source) =>
    set((s) => {
      const prev = s.byDoc[id];
      if (prev === undefined) return s;
      const compiler = source === "compiler" ? [] : prev.compiler;
      const tinymist = source === "tinymist" ? [] : prev.tinymist;
      // If both sources are now empty, drop the entry entirely so the store
      // doesn't accumulate empty slots for closed docs.
      if (compiler.length === 0 && tinymist.length === 0) {
        const next = { ...s.byDoc };
        delete next[id];
        return { byDoc: next };
      }
      return { byDoc: { ...s.byDoc, [id]: makeDoc(compiler, tinymist) } };
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
