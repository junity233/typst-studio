import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import { useActiveDocument } from "../../store/tabsStore";
import type { CompileStatus } from "../../lib/ui-types";
import { useLspStatus } from "../../store/lspStore";
import { useStartupProblemsStore } from "../../store/startupProblemsStore";
import { useSaveStateStore } from "../../store/saveStateStore";

/** Stable empty array so the selector returns the same reference when unset. */
const EMPTY_DIAGNOSTICS: readonly never[] = Object.freeze([]) as never[];

function statusLabel(
  status: CompileStatus,
  durationMs: number | null,
): string {
  switch (status) {
    case "compiling":
      return "Compiling…";
    case "success":
      return durationMs !== null ? `Compiled in ${durationMs}ms` : "Compiled";
    case "error":
      return "Compile failed";
    case "idle":
    default:
      return "Ready";
  }
}

function lspLabel(running: boolean, available: boolean): string {
  if (!available) return "LSP: not installed";
  if (!running) return "LSP: stopped";
  return "LSP: connected";
}

export function StatusBar() {
  const tab = useActiveDocument();
  const diagnostics = useDiagnosticsStore((s) =>
    tab !== null ? (s.byTab[tab.id] ?? EMPTY_DIAGNOSTICS) : EMPTY_DIAGNOSTICS,
  );
  const errorCount = diagnostics.filter((d) => d.severity === "Error").length;
  const status = tab?.status ?? "idle";
  const statusClass =
    status === "compiling"
      ? "statusbar-status--compiling"
      : status === "error"
        ? "statusbar-status--error"
        : "";

  const { status: lspStatus } = useLspStatus();

  // §5.3 save state (saving indicator / red save-failed). Minimal for Batch 4:
  // a label that reflects the active doc's SaveState. The full failure UI
  // (retry / Save As / open-dir / copy-details) is a follow-up. Reactive
  // selector so the label updates on each save_state_changed event.
  const activeId = tab?.id ?? null;
  const saveState = useSaveStateStore((s) =>
    activeId !== null ? (s.byDoc[activeId] ?? "idle") : "idle",
  );
  let saveLabel = "";
  let saveClass = "";
  if (typeof saveState !== "string") {
    if ("saving" in saveState) {
      saveLabel = "Saving…";
    } else if ("saved" in saveState) {
      saveLabel = ""; // Saved is the normal state — no label.
    } else if ("failed" in saveState) {
      saveLabel = "Save failed";
      saveClass = "statusbar-status--error";
    }
  }

  // Non-fatal startup problems (§6.5): show a count badge when present. The
  // full problem-panel UI is a later batch (S19); for now this is a minimal
  // non-modal indicator. Clicking dismisses (acknowledges) the problems.
  const problemCount = useStartupProblemsStore((s) => s.problems.length);
  const dismissProblems = useStartupProblemsStore((s) => s.dismiss);

  return (
    <footer className="statusbar">
      <span className={"statusbar-section" + (statusClass ? " " + statusClass : "")}>
        {tab !== null ? statusLabel(tab.status, tab.durationMs) : "No document"}
      </span>
      {saveLabel !== "" && (
        <span
          className={
            "statusbar-section" + (saveClass ? " " + saveClass : "")
          }
          title={
            typeof saveState !== "string" && "failed" in saveState
              ? saveState.failed.message
              : saveLabel
          }
        >
          {saveLabel}
        </span>
      )}
      <span className="statusbar-section">
        {errorCount > 0
          ? (
            <span className="statusbar-badge-error">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )
          : <span className="statusbar-badge">No errors</span>}
      </span>
      <span className="statusbar-section statusbar-lsp">
        {lspLabel(lspStatus.running, lspStatus.available)}
      </span>
      {problemCount > 0 && (
        <span
          className="statusbar-section statusbar-badge-error"
          role="button"
          title="Startup had non-fatal issues — click to dismiss"
          onClick={dismissProblems}
        >
          {problemCount} startup {problemCount === 1 ? "issue" : "issues"}
        </span>
      )}
    </footer>
  );
}
