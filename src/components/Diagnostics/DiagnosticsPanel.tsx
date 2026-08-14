import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDiagnosticsForDoc } from "../../store/diagnosticsStore";
import type { Diagnostic, Range } from "../../lib/types";

interface DiagnosticsPanelProps {
  tabId?: string;
  collapsed: boolean;
  /** Resizable body height in px (managed by the parent's drag sash). */
  bodyHeight?: number;
  /** True while the resize sash is being dragged — disables the body's height
   *  transition so it tracks the cursor 1:1 instead of lagging. */
  dragging?: boolean;
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

function severityLabelKey(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case "Error":
      return "severity.error";
    case "Warning":
      return "severity.warning";
    case "Info":
    default:
      return "severity.info";
  }
}

export function DiagnosticsPanel({
  tabId,
  collapsed,
  bodyHeight,
  dragging,
  onToggle,
  onGoto,
}: DiagnosticsPanelProps) {
  const { t } = useTranslation("diagnostics");
  // Links the collapse toggle (aria-controls) to the body it hides.
  const bodyId = useId();
  // §13.1: the combined view (compiler + tinymist) for this doc. The selector
  // returns a stable empty array when there is nothing to show.
  const diagnostics = useDiagnosticsForDoc(tabId);

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
    <section
      className={"diagnostics" + (collapsed ? " collapsed" : "")}
      data-diagnostics-panel=""
      data-diagnostics-collapsed={collapsed ? "true" : "false"}
    >
      <div className="diagnostics-header">
        <button
          className="diagnostics-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
        >
          {collapsed ? "▸" : "▾"} {t("title")}
          {sorted.length > 0 && (
            <span className="diagnostics-count">{sorted.length}</span>
          )}
        </button>
      </div>
      <div
        id={bodyId}
        className={"diagnostics-body" + (dragging ? " dragging" : "")}
        style={
          /* Only apply the resize height when expanded — when collapsed the
             CSS `.diagnostics.collapsed .diagnostics-body { max-height: 0 }`
             rule must win so the body disappears under the floating thin bar.
             Inline styles otherwise override that stylesheet rule. */
          !collapsed && bodyHeight != null
            ? { maxHeight: bodyHeight, height: bodyHeight }
            : undefined
        }
      >
        {sorted.length === 0 ? (
          <div className="diag-empty">{t("empty")}</div>
        ) : (
          <table className="diag-table">
            <thead>
              <tr>
                <th className="diag-col-sev" scope="col"> </th>
                <th className="diag-col-loc" scope="col">{t("columns.line")}</th>
                <th className="diag-col-msg" scope="col">{t("columns.message")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const sevClass = severityClass(d.severity);
                return (
                <tr
                  key={`${d.range.start_line}:${d.range.start_column}:${d.message}`}
                  className={`diag-row ${sevClass}`}
                  onDoubleClick={() => onGoto(d.range)}
                  onKeyDown={(e) => {
                    // Keyboard parity with the double-click jump (Space would
                    // otherwise scroll the pane).
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onGoto(d.range);
                    }
                  }}
                  tabIndex={0}
                  aria-label={t("row.ariaLabel", {
                    severity: t(severityLabelKey(d.severity)),
                    line: d.range.start_line,
                    column: d.range.start_column,
                    message: d.message,
                  })}
                  title={t("row.jumpTitle")}
                >
                  <td className="diag-col-sev">
                    <span className={`diag-sev-text ${sevClass}`}>
                      {t(severityLabelKey(d.severity))}
                    </span>
                  </td>
                  <td className="diag-col-loc">
                    <span className="diag-loc-line">{t("row.line", { line: d.range.start_line })}</span>
                    <span className="diag-loc-col">{t("row.column", { column: d.range.start_column })}</span>
                  </td>
                  <td className="diag-col-msg">{d.message}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
