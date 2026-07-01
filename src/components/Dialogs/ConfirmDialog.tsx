import { useDialogStore } from "../../store/dialogStore";

/**
 * A modal confirmation dialog. Renders only when a request is pending
 * (`dialogStore.current`). Used for the "close unsaved tab?" guard: Save /
 * Don't Save / Cancel. Keyboard: Enter = primary, Esc = cancel.
 */
export function ConfirmDialog() {
  const current = useDialogStore((s) => s.current);
  const resolve = useDialogStore((s) => s.resolve);

  if (current === null) return null;

  const confirmLabel = current.confirmLabel ?? "Save";
  const cancelLabel = current.cancelLabel ?? "Cancel";
  const discardLabel = current.discardLabel ?? "Don't Save";

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
