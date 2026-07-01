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

  return (
    <section className={"diagnostics" + (collapsed ? " collapsed" : "")}>
      <div className="diagnostics-header">
        <button className="diagnostics-toggle" onClick={onToggle}>
          {collapsed ? "▸" : "▾"} Diagnostics
          {diagnostics.length > 0 && (
            <span className="diagnostics-count">{diagnostics.length}</span>
          )}
        </button>
      </div>
      <div className="diagnostics-body">
        {diagnostics.length === 0 ? (
          <div className="diag-empty">No diagnostics</div>
        ) : (
          <ul className="diag-list">
            {diagnostics.map((d, i) => (
              <li
                key={i}
                className={`diag-item ${severityClass(d.severity)}`}
                onClick={() => onGoto(d.range)}
              >
                <span
                  className={`diag-dot ${severityClass(d.severity)}`}
                  aria-hidden="true"
                />
                <span className="diag-message">{d.message}</span>
                <span className="diag-loc">
                  {d.range.start_line}:{d.range.start_column}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
