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
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

function statusLabel(
  t: TFunction<"statusbar">,
  status: CompileStatus,
  durationMs: number | null,
): string {
  switch (status) {
    case "compiling":
      return t("status.compiling");
    case "slow":
      // §6.2: a compile that has run past the slow threshold. Still in
      // progress — a terminal success/error follows.
      return t("status.compilingSlow");
    case "success":
      return durationMs !== null
        ? t("status.compiledIn", { ms: durationMs })
        : t("status.compiled");
    case "error":
      return t("status.compileFailed");
    case "idle":
    default:
      return t("status.ready");
  }
}

/**
 * §6.4: LSP status label reflecting the lifecycle kind. Maps each
 * `LspStatusKind` to a short StatusBar string; surfaces the optional
 * `message` hint (e.g. the `Failed` "manual restart required" text) and the
 * `restartReason` trigger when present.
 */
function lspLabel(
  t: TFunction<"statusbar">,
  statusKind: LspStatusKind,
  available: boolean,
  message: string | null,
): string {
  if (!available && statusKind === "unavailable") return t("lsp.notInstalled");
  switch (statusKind) {
    case "disabled":
      return t("lsp.off");
    case "unavailable":
      return t("lsp.notInstalled");
    case "failed":
      // `message` carries the "manual restart required" hint on this branch.
      return message ? t("lsp.message", { message }) : t("lsp.restartNeeded");
    case "restarting":
      return t("lsp.reconnecting");
    case "awaitingClient":
      return t("lsp.connecting");
    case "running":
      return t("lsp.connected");
    default:
      return t("lsp.restartNeeded");
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
  const { t } = useTranslation("statusbar");
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
      saveLabel = t("save.saving");
    } else if ("saved" in saveState) {
      saveLabel = ""; // Saved is the normal state — no label.
    } else if ("failed" in saveState) {
      saveLabel = t("save.saveFailed");
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
        {tab !== null ? statusLabel(t, tab.status, tab.durationMs) : t("noDocument")}
      </span>
      {isConflicted && tab !== null && (
        <span
          className="statusbar-section statusbar-status--conflict"
          role="button"
          title={t("conflict.title")}
          onClick={() => openConflict(tab.id)}
        >
          {t("conflict.label")}
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
              {t("errors.count", { count: errorCount })}
            </span>
          )
          : <span className="statusbar-badge">{t("errors.none")}</span>}
      </span>
      {watcherFailed && (
        <span
          className="statusbar-section statusbar-status--conflict"
          title={t("watcher.limitedTitle")}
        >
          {t("watcher.limited")}
        </span>
      )}
      <span
        className={
          "statusbar-section statusbar-lsp" +
          (needsAction ? " statusbar-lsp--action" : "")
        }
        title={
          lspStatus.restartReason
            ? t("lsp.lastTrigger", { reason: lspStatus.restartReason })
            : lspStatus.message ?? undefined
        }
      >
        {lspLabel(t, lspStatus.statusKind, lspStatus.available, lspStatus.message)}
        {needsAction && (
          <button
            type="button"
            className="statusbar-lsp-restart"
            title={t("lsp.restartButtonTitle")}
            onClick={restartLsp}
          >
            {t("lsp.restartButton")}
          </button>
        )}
      </span>
      {problemCount > 0 && (
        <span
          className="statusbar-section statusbar-badge-error"
          title={t("startupProblems.countTitle", { count: problemCount })}
        >
          {t("startupProblems.count", { count: problemCount })}
        </span>
      )}
    </footer>
  );
}
