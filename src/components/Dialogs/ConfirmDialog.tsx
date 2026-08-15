import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import {
  useDialogStore,
  type ConfirmRequest,
  type ConfirmResult,
} from "../../store/dialogStore";

/**
 * A modal confirmation dialog. Renders only when a request is pending
 * (`dialogStore.current`). Used for the "close unsaved tab?" guard: Save /
 * Don't Save / Cancel. Keyboard: Enter activates the focused button,
 * Esc = cancel.
 *
 * Focus management (a11y):
 * - The element focused before the dialog opened is recorded and refocused
 *   when it closes.
 * - Tab / Shift+Tab cycle INSIDE the dialog (focus trap) — keyboard users can
 *   never tab into the background UI behind a modal.
 * - `danger` requests (delete / permanent delete / clear) put the INITIAL
 *   focus on Cancel instead of Confirm, so a reflexive Enter right after the
 *   dialog opens cannot fire an irreversible action.
 */
export function ConfirmDialog() {
  const current = useDialogStore((s) => s.current);
  const resolve = useDialogStore((s) => s.resolve);

  if (current === null) return null;

  // The body's focus effect depends on the request object itself, so a queued
  // follow-up confirmation (resolve swaps `current` A→B) re-runs the focus
  // save/restore cycle: A's cleanup restores its opener, B's setup records
  // that element as its own "previously focused" and moves focus into B.
  return <ConfirmDialogBody request={current} resolve={resolve} />;
}

function ConfirmDialogBody({
  request,
  resolve,
}: {
  request: ConfirmRequest;
  resolve: (result: ConfirmResult) => void;
}) {
  const { t } = useTranslation(["dialog", "common"]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  // Set the initial focus and remember where focus came from; on close
  // (dialog resolved OR replaced by a queued request) hand focus back.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    (request.danger ? cancelRef : confirmRef).current?.focus();
    return () => {
      // Skip if the opener left the DOM meanwhile (its view unmounted, etc.).
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
    // `request` identity: a new pending request must re-run this cycle.
  }, [request]);

  // Esc = cancel. Window-level listener (see useEscapeToClose): clicking
  // non-focusable chrome (title/padding) moves focus to <body>, where the
  // overlay-level onKeyDown never fires — and this dialog guards destructive
  // deletes, so Escape must work regardless of focus. Attached while the body
  // is mounted (it renders only for a pending request).
  useEscapeToClose(true, () => resolve("cancel"));

  // Tab / Shift+Tab wrap within the dialog (focus trap). Escape is handled at
  // the window level (above).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        [
          "button:not([disabled])",
          "[href]",
          "input:not([disabled])",
          "select:not([disabled])",
          "textarea:not([disabled])",
          '[tabindex]:not([tabindex="-1"])',
        ].join(", "),
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && dialog.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // When a caller omits a label, fall back to the translated common strings so
  // the defaults localize with the rest of the UI.
  const confirmLabel = request.confirmLabel ?? t("common:save");
  const cancelLabel = request.cancelLabel ?? t("common:cancel");
  // The discard ("Don't Save") button is specific to the unsaved-tab-close
  // flow; binary confirms (delete, clear, apply-edit, save-as-fallback) omit
  // `discardLabel` and render only Cancel + Confirm.
  const showDiscard = request.discardLabel !== undefined;

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={() => resolve("cancel")}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{request.title}</h2>
        <p id={messageId} className="dialog-message">
          {request.message}
        </p>
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            className="btn-utility"
            onClick={() => resolve("cancel")}
          >
            {cancelLabel}
          </button>
          {showDiscard && (
            <button
              className="btn-ghost"
              onClick={() => resolve("discard")}
            >
              {request.discardLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            className="btn-primary"
            onClick={() => resolve("confirm")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
