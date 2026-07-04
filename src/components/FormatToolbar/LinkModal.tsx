import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface LinkModalProps {
  /**
   * Pre-fill the label field with the current selection text (if any), so the
   * user sees what they're linking and can confirm as-is or type a new label
   * (spec §5.3). The toolbar captures this from the editor's selection when it
   * opens the modal.
   */
  initialLabel?: string;
  /** Called with the trimmed URL + label when the user confirms. */
  onConfirm: (url: string, label: string) => void;
  /** Called on Esc, outside-click, or the cancel button. */
  onCancel: () => void;
}

/**
 * A tiny two-field modal (URL + optional label) for the toolbar's Insert Link
 * button. Rendered into `document.body` via a portal, reusing the
 * `.dialog-overlay` / `.dialog` CSS the confirm/recovery dialogs already use
 * (global.css) so it matches the app's modal look without duplicating chrome.
 *
 * Behavior mirrors the other dialogs: Enter submits (when the URL is
 * non-empty), Esc cancels, clicking the overlay cancels, and the URL input is
 * focused on mount. The label is optional — an empty label yields a bare
 * `#link("url")` (no `[label]`); the parent decides the exact Typst string.
 *
 * This is a controlled-by-parent component: it owns only its own field state;
 * `onConfirm` / `onCancel` report the result and the parent unmounts it.
 */
export function LinkModal({ initialLabel = "", onConfirm, onCancel }: LinkModalProps) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState(initialLabel);
  const urlRef = useRef<HTMLInputElement>(null);

  // Autofocus the URL field on mount. A one-shot effect (no deps): the modal
  // mounts fresh each time it opens, so there's nothing to re-focus on update.
  useEffect(() => {
    urlRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = url.trim();
    if (trimmed === "") return; // URL is required; empty → no-op (don't close)
    onConfirm(trimmed, label.trim());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  };

  return createPortal(
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={onCancel}
      // Capture Esc at the overlay so it fires even when focus is in a field.
      // Stop propagation after handling so an ancestor keydown (e.g. the
      // editor) doesn't also react.
      onKeyDown={onKeyDown}
    >
      <div
        className="dialog link-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Insert link"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">Insert link</h2>
        <form
          className="link-modal-form"
          // Enter inside any field submits the form; we handle it ourselves so
          // an empty URL is a no-op rather than a confirm.
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          onKeyDown={(e) => {
            // Explicit Enter handling: jsdom doesn't synthesize a form submit
            // from a keydown{Enter} on a text input the way real browsers do,
            // and being explicit here is also robust against any future
            // change to the form's submit button. Escape is handled at the
            // overlay (below); stopPropagation keeps it from double-firing.
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        >
          <label className="link-modal-field">
            <span className="link-modal-label">URL</span>
            <input
              ref={urlRef}
              className="link-modal-input"
              type="text"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="link-modal-field">
            <span className="link-modal-label">Label (optional)</span>
            <input
              className="link-modal-input"
              type="text"
              placeholder="link text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn-utility"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Insert
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
