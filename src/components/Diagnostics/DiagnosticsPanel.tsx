import { useMemo } from "react";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import type { Diagnostic, Range } from "../../lib/types";

/** Stable empty array so the selector returns the same reference when unset. */
const EMPTY_DIAGNOSTICS: readonly never[] = Object.freeze([]) as never[];

interface DiagnosticsPanelProps {
  tabId?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Called with the diagnostic's range when a row is clicked. */
  onGoto: (range: Range) => void;
}

function severityClass(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case "Error":
      return "diag-sev-error";
    case "Warning":
      return "diag-sev-warning";
    case "Info":
    default:
      return "diag-sev-info";
  }
}

function severityLabel(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case "Error":
      return "Error";
    case "Warning":
      return "Warning";
    case "Info":
    default:
      return "Info";
  }
}

export function DiagnosticsPanel({
  tabId,
  collapsed,
  onToggle,
  onGoto,
}: DiagnosticsPanelProps) {
  const diagnostics = useDiagnosticsStore((s) =>
    tabId !== undefined
      ? (s.byTab[tabId] ?? EMPTY_DIAGNOSTICS)
      : EMPTY_DIAGNOSTICS,
  );

  // Sort by start line, then column — stable, predictable top-to-bottom order.
  const sorted = useMemo(
    () =>
      [...diagnostics].sort(
        (a, b) =>
          a.range.start_line - b.range.start_line ||
          a.range.start_column - b.range.start_column,
      ),
    [diagnostics],
  );

  return (
    <section className={"diagnostics" + (collapsed ? " collapsed" : "")}>
      <div className="diagnostics-header">
        <button className="diagnostics-toggle" onClick={onToggle}>
          {collapsed ? "▸" : "▾"} Diagnostics
          {sorted.length > 0 && (
            <span className="diagnostics-count">{sorted.length}</span>
          )}
        </button>
      </div>
      <div className="diagnostics-body">
        {sorted.length === 0 ? (
          <div className="diag-empty">No diagnostics</div>
        ) : (
          <table className="diag-table">
            <thead>
              <tr>
                <th className="diag-col-sev" scope="col"> </th>
                <th className="diag-col-loc" scope="col">Line</th>
                <th className="diag-col-msg" scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d, i) => (
                <tr
                  key={i}
                  className={`diag-row ${severityClass(d.severity)}`}
                  onDoubleClick={() => onGoto(d.range)}
                  title="Double-click to jump to line"
                >
                  <td className="diag-col-sev">
                    <span className={`diag-sev-text ${severityClass(d.severity)}`}>
                      {severityLabel(d.severity)}
                    </span>
                  </td>
                  <td className="diag-col-loc">
                    <span className="diag-loc-line">line {d.range.start_line}</span>
                    <span className="diag-loc-col">column {d.range.start_column}</span>
                  </td>
                  <td className="diag-col-msg">{d.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
