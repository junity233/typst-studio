import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBatchExportStore } from "../../store/batchExportStore";

/**
 * Batch-export dialog: pick any of the workspace's `.typ` files and export
 * each as a PDF in one pass. Rendered while `batchExportStore.open`; state
 * machine (loading → picking → exporting → done) lives in the store — this
 * component is presentation only. The output FOLDER is picked by the backend
 * when the export starts (same trust model as the single-export save dialog),
 * so there is no folder picker here.
 *
 * Reuses the shared `.dialog-overlay` / `.dialog` chrome (like
 * ConfirmDialog / ConflictDialog); the file list is a plain scrollable
 * checkbox list.
 */
export function BatchExportDialog() {
  const { t } = useTranslation("batchExport");
  const state = useBatchExportStore();
  const close = state.close;

  // Esc closes while picking (not mid-export — let the run finish so the
  // backend-only tabs still get released; the dialog stays for the results).
  useEffect(() => {
    if (!state.open || state.phase === "exporting") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.open, state.phase, close]);

  if (!state.open) return null;

  return (
    <div className="dialog-overlay">
      <div
        className="dialog dialog-batch-export"
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
      >
        <h2 className="dialog-title">{t("title")}</h2>

        {state.phase === "loading" && (
          <p className="dialog-message">{t("loading")}</p>
        )}

        {(state.phase === "picking" || state.phase === "exporting") && (
          <>
            <div className="batch-export-toolbar">
              <button
                type="button"
                className="btn-ghost"
                onClick={state.selectAll}
                disabled={state.phase === "exporting"}
              >
                {t("selectAll")}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={state.clearSelection}
                disabled={state.phase === "exporting"}
              >
                {t("clearSelection")}
              </button>
              <span className="batch-export-count">
                {t("selectedCount", { count: state.selected.size })}
              </span>
            </div>
            {state.error !== null && (
              <p className="dialog-message batch-export-error">{state.error}</p>
            )}
            {state.files.length === 0 ? (
              <p className="dialog-message">{t("noFiles")}</p>
            ) : (
              <ul className="batch-export-list" role="listbox" aria-multiselectable="true">
                {state.files.map((f) => (
                  <li key={f.absPath}>
                    <label>
                      <input
                        type="checkbox"
                        checked={state.selected.has(f.absPath)}
                        onChange={() => state.toggle(f.absPath)}
                        disabled={state.phase === "exporting"}
                      />
                      <span className="batch-export-relpath" title={f.absPath}>
                        {f.relPath}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn-utility"
                onClick={close}
                disabled={state.phase === "exporting"}
              >
                {t("cancel", { ns: "common" })}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void state.run()}
                disabled={state.phase === "exporting" || state.selected.size === 0}
              >
                {state.phase === "exporting" ? t("exporting") : t("exportPdf")}
              </button>
            </div>
          </>
        )}

        {state.phase === "done" && (
          <>
            <ul className="batch-export-results">
              {state.results?.map((r) => (
                <li
                  key={r.name}
                    className={r.error !== undefined ? "batch-export-failed" : undefined}
                >
                  {r.error !== undefined
                    ? t("resultFailed", { name: r.name, error: r.error })
                    : t("resultOk", { name: r.name, path: r.path ?? "" })}
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button type="button" className="btn-primary" onClick={close}>
                {t("close", { ns: "common" })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
