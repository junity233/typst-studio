import type { editor } from "monaco-editor";
import type { Diagnostic, Severity } from "../../lib/types";

/**
 * Map a backend `Severity` string to the numeric `MarkerSeverity` value
 * (monaco.MarkerSeverity: Error=8, Warning=4, Info=2, Hint=1). Hardcoded so the
 * function stays pure and does not need a live monaco instance.
 */
function severityValue(s: Severity): number {
  switch (s) {
    case "Error":
      return 8;
    case "Warning":
      return 4;
    case "Info":
    default:
      return 2;
  }
}

/**
 * Convert backend diagnostics into Monaco `IMarkerData` for squiggly underlines
 * and the problems panel. Ranges in the IPC contract are already 1-indexed,
 * matching Monaco's 1-indexed `{start,end}Line/Column`.
 */
export function toMonacoMarkers(
  diags: Diagnostic[],
): editor.IMarkerData[] {
  return diags.map((d) => ({
    severity: severityValue(d.severity),
    message: d.message,
    code: d.code !== null ? String(d.code) : undefined,
    startLineNumber: d.range.start_line,
    startColumn: d.range.start_column,
    endLineNumber: d.range.end_line,
    endColumn: d.range.end_column,
  }));
}
