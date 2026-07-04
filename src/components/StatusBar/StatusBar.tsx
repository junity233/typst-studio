import { useDiagnosticsForDoc } from "../../store/diagnosticsStore";
import { useActiveDocument } from "../../store/tabsStore";
import type { CompileStatus } from "../../lib/ui-types";
import type { LspStatusKind } from "../../lib/types";
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
 * §6.4: LSP status label reflecting the lifecycle kind. Maps each
 * `LspStatusKind` to a short StatusBar string; surfaces the optional
 * `message` hint (e.g. the `Failed` "manual restart required" text) and the
 * `restartReason` trigger when present.
 */
function lspLabel(
  statusKind: LspStatusKind,
  available: boolean,
  message: string | null,
): string {
  if (!available && statusKind === "unavailable") return "LSP: not installed";
  switch (statusKind) {
    case "disabled":
      return "LSP: off";
    case "unavailable":
      return "LSP: not installed";
    case "failed":
      // `message` carries the "manual restart required" hint on this branch.
      return message ? `LSP: ${message}` : "LSP: restart needed";
    case "restarting":
      return "LSP: reconnecting…";
    case "starting":
    case "awaitingClient":
      return "LSP: connecting…";
    case "running":
      return "LSP: connected";
    default:
      return "LSP: restart needed";
  }
}

/**
 * Whether the LSP status bar entry should show a clickable "Restart"
 * affordance. True whenever the LSP is enabled but not yet `running`
 * (restarting/failed/awaiting-client/etc.) — i.e. the user can productively
 * nudge it with a manual restart. `disabled`/`unavailable` hide the button
 * (a restart won't help: tinymist is missing or LSP is turned off).
 */
function lspNeedsAction(statusKind: LspStatusKind, available: boolean): boolean {
  if (!available && statusKind === "unavailable") return false;
  switch (statusKind) {
    case "disabled":
    case "unavailable":
    case "running":
      return false;
    default:
      return true;
  }
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

  // §6.3/§6.4: show a clickable "Restart" affordance whenever the LSP is
  // enabled but not yet running (restarting/failed/awaiting-client/etc.). The
  // button invokes the existing `restart_lsp` IPC (Manual reason), which
  // re-arms the supervisor and (if parked) revives the accept loop.
  const needsAction = lspNeedsAction(
    lspStatus.statusKind,
    lspStatus.available,
  );
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
          (needsAction ? " statusbar-lsp--action" : "")
        }
        title={
          lspStatus.restartReason
            ? `Last trigger: ${lspStatus.restartReason}`
            : lspStatus.message ?? undefined
        }
      >
        {lspLabel(lspStatus.statusKind, lspStatus.available, lspStatus.message)}
        {needsAction && (
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
