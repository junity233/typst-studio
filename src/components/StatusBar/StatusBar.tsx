import { useDiagnosticsForDoc } from "../../store/diagnosticsStore";
import { useActiveDocument } from "../../store/tabsStore";
import type { CompileStatus } from "../../lib/ui-types";
import { useLspStatus } from "../../store/lspStore";
import { useStartupProblemsStore } from "../../store/startupProblemsStore";
import { useSaveStateStore } from "../../store/saveStateStore";
import { useConflictDialogStore } from "../../store/conflictDialogStore";
import { useWatcherHealthStore } from "../../store/watcherHealthStore";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

function statusLabel(
  status: CompileStatus,
  durationMs: number | null,
): string {
  switch (status) {
    case "compiling":
      return "Compiling…";
    case "slow":
      // §6.2: a compile that has run past the slow threshold. Still in
      // progress — a terminal success/error follows.
      return "Compiling… (taking a while)";
    case "success":
      return durationMs !== null ? `Compiled in ${durationMs}ms` : "Compiled";
    case "error":
      return "Compile failed";
    case "idle":
    default:
      return "Ready";
  }
}

/**
 * §6.3: LSP status label reflecting the supervision states. The label grows
 * from the prior 3-state (not installed / stopped / connected) to include
 * "Reconnecting…" (during backoff) and "Restart needed" (after backoff
 * exhaustion). `restartLsp` is wired to the existing `restart_lsp` IPC.
 */
function lspLabel(
  running: boolean,
  available: boolean,
  reconnecting: boolean,
): string {
  if (!available) return "LSP: not installed";
  if (reconnecting) return "LSP: reconnecting…";
  if (!running) return "LSP: restart needed";
  return "LSP: connected";
}

export function StatusBar() {
  const tab = useActiveDocument();
  // §13.1: combined diagnostics (compiler + tinymist) for the active doc.
  const diagnostics = useDiagnosticsForDoc(tab?.id ?? null);
  const errorCount = diagnostics.filter((d) => d.severity === "Error").length;
  const status = tab?.status ?? "idle";
  const statusClass =
    status === "compiling" || status === "slow"
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

  // Non-fatal startup problems (§6.5): a small persistent count indicator.
  // The full non-modal panel (StartupProblemsPanel) lists each problem with
  // copy-details + dismiss; this badge is the always-visible footprint so the
  // user knows there were issues even after dismissing the panel.
  const problemCount = useStartupProblemsStore((s) => s.problems.length);

  // §5.4 / §8 conflict indicator: orange "Conflict" entry when the active doc
  // is in an unresolved conflict. Clicking opens the resolution dialog.
  const openConflict = useConflictDialogStore((s) => s.open);
  const isConflicted = tab !== null && tab.conflict !== "none";

  // §6.3 watcher-health warning: shown when the workspace watcher failed to
  // start. Refreshed once on mount and whenever the active doc changes (a
  // workspace open/close is the only transition; the poll fallback compensates
  // server-side, so this is just a promptness heads-up).
  const watcherFailed = useWatcherHealthStore((s) => s.watcherFailed);
  const refreshWatcherHealth = useWatcherHealthStore((s) => s.refresh);
  useEffect(() => {
    void refreshWatcherHealth();
  }, [refreshWatcherHealth]);

  // §6.3: show a clickable "Restart" affordance whenever LSP is not connected
  // (stopped, reconnecting, restart-needed, or not installed). The button
  // invokes the existing `restart_lsp` IPC, which re-arms the supervisor and
  // (if parked) revives the accept loop. A no-op click when already connected.
  const lspNeedsAction =
    lspStatus.available &&
    (lspStatus.reconnecting || !lspStatus.running);
  const restartLsp = () => {
    // Fire-and-forget; the lsp_status event updates the UI.
    invoke("restart_lsp").catch(() => {
      /* a failed restart is non-fatal; the next status event catches up */
    });
  };

  return (
    <footer className="statusbar">
      <span className={"statusbar-section" + (statusClass ? " " + statusClass : "")}>
        {tab !== null ? statusLabel(tab.status, tab.durationMs) : "No document"}
      </span>
      {isConflicted && tab !== null && (
        <span
          className="statusbar-section statusbar-status--conflict"
          role="button"
          title="This file changed on disk and is in conflict — click to resolve"
          onClick={() => openConflict(tab.id)}
        >
          Conflict
        </span>
      )}
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
      {watcherFailed && (
        <span
          className="statusbar-section statusbar-status--conflict"
          title="Live external-change detection is unavailable (the polling fallback is active). Reload/compare may be slightly delayed."
        >
          External detection limited
        </span>
      )}
      <span
        className={
          "statusbar-section statusbar-lsp" +
          (lspNeedsAction ? " statusbar-lsp--action" : "")
        }
      >
        {lspLabel(lspStatus.running, lspStatus.available, lspStatus.reconnecting)}
        {lspNeedsAction && (
          <button
            type="button"
            className="statusbar-lsp-restart"
            title="Restart the LSP server"
            onClick={restartLsp}
          >
            Restart
          </button>
        )}
      </span>
      {problemCount > 0 && (
        <span
          className="statusbar-section statusbar-badge-error"
          title={`${problemCount} startup ${problemCount === 1 ? "issue" : "issues"} — see the problems panel`}
        >
          {problemCount} startup {problemCount === 1 ? "issue" : "issues"}
        </span>
      )}
    </footer>
  );
}
