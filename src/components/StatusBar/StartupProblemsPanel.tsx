import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useStartupProblemsStore } from "../../store/startupProblemsStore";
import type { StartupProblem } from "../../lib/types";

/**
 * Non-modal startup-problems panel (§6.5 "失败项汇总到非模态'启动问题'面板").
 *
 * The backend emits `startup_problems` once at end of setup when one or more
 * startup components degraded (config dir, settings, session, recovery, fonts,
 * etc.). A single component failure must never block the main window — the
 * problems are collected and surfaced here as a dismissible, non-intrusive
 * panel.
 *
 * Behaviour:
 * - Renders only when there are problems AND the user hasn't dismissed the
 *   panel (a `dismissed` local flag, separate from the store's `dismiss`, so a
 *   re-emission — e.g. on a settings change that re-runs setup — re-shows it).
 * - Lists each problem's component + message.
 * - "Copy details" copies a plain-text summary to the clipboard for bug reports.
 * - "Dismiss" closes the panel (the StatusBar keeps a small persistent badge).
 *
 * The panel is non-modal: it overlays a corner of the workbench but does not
 * block pointer input to the editor. It auto-stays until dismissed (the design
 * doc says "non-intrusive... auto-dismiss after the user views" — we keep it
 * visible until explicit dismiss so the user can act on it, with a small
 * footprint).
 */
export function StartupProblemsPanel() {
  const { t } = useTranslation("statusbar");
  const problems = useStartupProblemsStore((s) => s.problems);
  const clearStore = useStartupProblemsStore((s) => s.dismiss);
  const [dismissed, setDismissed] = useState(false);

  // Re-emission re-shows the panel (the doc comment's stated intent): the user
  // dismissed THIS set, not all future ones. We compare by a component+message
  // signature so a genuinely new problem set resurfaces the panel, while an
  // identical re-emit (e.g. a redundant broadcast of the same problems) does
  // NOT re-spawn a panel the user just closed — that would be a dismiss loop.
  const prevSignatureRef = useRef<string>("");
  useEffect(() => {
    const sig = problems
      .map((p) => `${p.component}\u0000${p.message}`)
      .join("\n");
    if (sig !== prevSignatureRef.current) {
      prevSignatureRef.current = sig;
      if (problems.length > 0) setDismissed(false);
    }
  }, [problems]);

  if (problems.length === 0 || dismissed) {
    return null;
  }

  const copyDetails = async () => {
    const text = formatDetails(t, problems);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable (permissions, non-secure context). The
      // copy is a convenience, not a critical path — fail silently.
    }
  };

  const dismiss = () => {
    setDismissed(true);
    clearStore();
  };

  return (
    <div
      className="startup-problems-panel"
      role="alert"
      aria-live="polite"
      aria-label={t("startupProblems.panelAriaLabel", { count: problems.length })}
    >
      <div className="startup-problems-panel-header">
        <span className="startup-problems-panel-title">
          {t("startupProblems.panelTitle", { count: problems.length })}
        </span>
        <div className="startup-problems-panel-actions">
          <button
            type="button"
            className="startup-problems-panel-btn"
            onClick={() => void copyDetails()}
            title={t("startupProblems.copyDetailsTitle")}
          >
            {t("startupProblems.copyDetails")}
          </button>
          <button
            type="button"
            className="startup-problems-panel-btn"
            onClick={dismiss}
            title={t("startupProblems.dismissTitle")}
          >
            {t("startupProblems.dismiss")}
          </button>
        </div>
      </div>
      <ul className="startup-problems-panel-list">
        {problems.map((p, i) => (
          <li key={`${p.component}-${i}`} className="startup-problems-panel-item">
            <span className="startup-problems-panel-component">{p.component}</span>
            <span className="startup-problems-panel-message">{p.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Format the problems as a plain-text block for clipboard / bug reports. */
function formatDetails(
  t: TFunction<"statusbar">,
  problems: StartupProblem[],
): string {
  const lines = problems.map(
    (p, i) => `${i + 1}. [${p.component}] ${p.message}`,
  );
  return [
    t("startupProblems.detailsHeader"),
    t("startupProblems.detailsCount", { count: problems.length }),
    "",
    ...lines,
  ].join("\n");
}
