import { useTranslation } from "react-i18next";
import { useDialogStore } from "../../store/dialogStore";

/**
 * A modal confirmation dialog. Renders only when a request is pending
 * (`dialogStore.current`). Used for the "close unsaved tab?" guard: Save /
 * Don't Save / Cancel. Keyboard: Enter = primary, Esc = cancel.
 */
export function ConfirmDialog() {
  const { t } = useTranslation(["dialog", "common"]);
  const current = useDialogStore((s) => s.current);
  const resolve = useDialogStore((s) => s.resolve);

  if (current === null) return null;

  // When a caller omits a label, fall back to the translated common strings so
  // the defaults localize with the rest of the UI.
  const confirmLabel = current.confirmLabel ?? t("common:save");
  const cancelLabel = current.cancelLabel ?? t("common:cancel");
  const discardLabel = current.discardLabel ?? t("common:dontSave");

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={() => resolve("cancel")}
      onKeyDown={(e) => {
        if (e.key === "Escape") resolve("cancel");
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{current.title}</h2>
        <p className="dialog-message">{current.message}</p>
        <div className="dialog-actions">
          <button className="btn-utility" onClick={() => resolve("cancel")}>
            {cancelLabel}
          </button>
          <button
            className="btn-ghost"
            onClick={() => resolve("discard")}
          >
            {discardLabel}
          </button>
          <button
            className="btn-primary"
            autoFocus
            onClick={() => resolve("confirm")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
