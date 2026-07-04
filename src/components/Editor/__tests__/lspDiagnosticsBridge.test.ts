import { describe, it, expect } from "vitest";
import {
  shouldDropDiagnosticsForGeneration,
  buildDiagnostic,
  selectDiagnosticsForDoc,
  getCombined,
} from "../lspDiagnosticsBridgeHelpers";
import type { DocDiagnostics } from "../../../store/diagnosticsStore";
import type { Diagnostic } from "../../../lib/types";

/**
 * Pure helpers extracted from the LSP diagnostics bridge (spec §13.2 / §17).
 * The bridge itself wires Monaco's `IMarkerService` and the
 * `appLanguageClient` singleton — neither runs under jsdom — so the spec-
 * critical logic is unit-tested at the pure-seam level (imported from the
 * Monaco-free helpers module): the generation gate, the marker→Diagnostic
 * builder, and the re-exported store selectors.
 */

describe("shouldDropDiagnosticsForGeneration (§13.2 / §16)", () => {
  it("drops a strictly-older generation", () => {
    expect(shouldDropDiagnosticsForGeneration(0, 1)).toBe(true);
    expect(shouldDropDiagnosticsForGeneration(3, 5)).toBe(true);
  });

  it("keeps an equal generation (refresh of the live gen, not stale)", () => {
    expect(shouldDropDiagnosticsForGeneration(0, 0)).toBe(false);
    expect(shouldDropDiagnosticsForGeneration(7, 7)).toBe(false);
  });

  it("keeps a strictly-newer generation", () => {
    expect(shouldDropDiagnosticsForGeneration(2, 1)).toBe(false);
    expect(shouldDropDiagnosticsForGeneration(10, 3)).toBe(false);
  });

  it("boundary: eventGen just below current is dropped, equal is kept", () => {
    expect(shouldDropDiagnosticsForGeneration(4, 5)).toBe(true);
    expect(shouldDropDiagnosticsForGeneration(5, 5)).toBe(false);
  });
});

describe("buildDiagnostic (§13.2 marker → Diagnostic)", () => {
  it("maps primitive fields to the Diagnostic shape with 1-indexed range", () => {
    const d = buildDiagnostic({
      severity: "Error",
      message: "missing semicolon",
      startLine: 10,
      startColumn: 3,
      endLine: 10,
      endColumn: 4,
    });
    const expected: Diagnostic = {
      severity: "Error",
      message: "missing semicolon",
      code: null,
      range: {
        start_line: 10,
        start_column: 3,
        end_line: 10,
        end_column: 4,
      },
    };
    expect(d).toEqual(expected);
  });

  it("always sets code to null (tinymist code is not surfaced)", () => {
    const d = buildDiagnostic({
      severity: "Warning",
      message: "x",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    });
    expect(d.code).toBeNull();
  });

  it("preserves each severity variant", () => {
    for (const severity of ["Error", "Warning", "Info"] as const) {
      const d = buildDiagnostic({
        severity,
        message: "m",
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 2,
      });
      expect(d.severity).toBe(severity);
    }
  });

  it("handles multi-line ranges", () => {
    const d = buildDiagnostic({
      severity: "Info",
      message: "multi",
      startLine: 5,
      startColumn: 1,
      endLine: 8,
      endColumn: 20,
    });
    expect(d.range).toEqual({
      start_line: 5,
      start_column: 1,
      end_line: 8,
      end_column: 20,
    });
  });
});

describe("re-exported store selectors (§17 single import path)", () => {
  it("selectDiagnosticsForDoc returns the combined view", () => {
    const slot: DocDiagnostics = {
      compiler: [
        {
          severity: "Error",
          message: "c",
          code: 1n,
          range: {
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 2,
          },
        },
      ],
      tinymist: [],
    };
    expect(selectDiagnosticsForDoc(slot, "compiler")).toBe(slot.compiler);
    expect(getCombined(slot)).toBe(slot.compiler);
  });
});
