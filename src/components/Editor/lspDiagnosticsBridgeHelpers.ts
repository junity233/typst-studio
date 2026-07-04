import type { Diagnostic, Severity } from "../../lib/types";
import {
  selectDiagnosticsForDoc,
  getCombined,
} from "../../store/diagnosticsStore";

/**
 * PURE helpers for the LSP diagnostics bridge (spec §13.2 / §17 testing seam).
 *
 * The bridge module ([`lspDiagnosticsBridge.ts`](./lspDiagnosticsBridge.ts))
 * wires Monaco's `IMarkerService` and the `appLanguageClient` singleton —
 * neither of which runs under jsdom (real Monaco pulls widget CSS + workers).
 * The spec-critical logic that DOES need unit coverage is extracted here so it
 * can be tested without any Monaco mocking:
 *
 * - [`shouldDropDiagnosticsForGeneration`](Self.shoulddropdiagnosticsforgeneration)
 *   — the stale-generation gate.
 * - [`buildDiagnostic`](Self.builddiagnostic) — the pure marker→Diagnostic
 *   builder (Monaco-type-free).
 *
 * The store-side selector (`selectDiagnosticsForDoc`) is re-exported here so
 * bridge consumers and tests have one import path for the pure diagnostics
 * helpers. This module imports ONLY from `lib/types` and the (Monaco-free)
 * store, so it is safe under jsdom.
 */
export { selectDiagnosticsForDoc, getCombined };
export type { DocDiagnostics, DiagnosticSource } from "../../store/diagnosticsStore";

/**
 * Generation gate for stale diagnostics (spec §13.2 "旧 generation 的
 * diagnostics 被丢弃", §16). Returns `true` when diagnostics tagged with
 * `eventGeneration` belong to a DEAD generation and must be dropped, `false`
 * when they are current and should be kept.
 *
 * Boundary: an event whose generation EQUALS the current one is CURRENT (a
 * refresh of the live generation, not stale). Only a strictly-older generation
 * is dropped. PURE — unit-tested directly.
 */
export function shouldDropDiagnosticsForGeneration(
  eventGeneration: number,
  currentGeneration: number,
): boolean {
  return eventGeneration < currentGeneration;
}

/**
 * Pure builder for a [`Diagnostic`](../../lib/types.ts) from primitive fields
 * (spec §13.2 marker → Diagnostic mapping). Extracted so the mapping is
 * unit-testable without Monaco types; the bridge keeps a thin
 * Monaco-typed glue (`markerToDiagnostic`) that adapts an `IMarkerData` to
 * these primitives.
 *
 * `code` is always `null` for tinymist-sourced diagnostics (the LSP
 * `Diagnostic.code` is not surfaced in the Problems UI today; the compiler
 * source carries the Typst code).
 */
export function buildDiagnostic(input: {
  severity: Severity;
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}): Diagnostic {
  return {
    severity: input.severity,
    message: input.message,
    code: null,
    range: {
      start_line: input.startLine,
      start_column: input.startColumn,
      end_line: input.endLine,
      end_column: input.endColumn,
    },
  };
}
