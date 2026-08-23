import { useEffect, useRef } from "react";
import { acquireEscapeDepth } from "./escapeStack";

/**
 * Close-on-Escape for modal portals: attach a window-level keydown listener
 * while `active`, calling `onClose` on Escape — but ONLY when this layer is
 * the topmost active one (see [`escapeStack`](./escapeStack)). With stacked
 * modals (ConfirmDialog over FormulaModal, DiffCard over a dialog, …) one
 * Escape press must close exactly one layer; `stopPropagation` cannot achieve
 * that because it does not stop sibling listeners on the same window target.
 *
 * Why window-level: clicking non-focusable chrome (title/padding) moves focus
 * to `<body>`, where the overlay's own `onKeyDown` never fires — Escape must
 * not depend on focus being inside the portal. This was previously
 * hand-rolled per dialog.
 *
 * The callbacks are kept in refs so the listener attaches/detaches only when
 * `active` flips, not on every re-render with a fresh closure.
 */
export function useEscapeToClose(
  active: boolean,
  onClose: () => void,
  options: {
    /**
     * Return true to swallow Escape WITHOUT closing (e.g. while an operation
     * is in flight). The event is still consumed by this (topmost) layer.
     */
    ignoreWhile?: () => boolean;
  } = {},
): void {
  const { ignoreWhile } = options;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ignoreRef = useRef(ignoreWhile);
  ignoreRef.current = ignoreWhile;

  useEffect(() => {
    if (!active) return;
    const depth = acquireEscapeDepth();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!depth.isTopmost()) return;
      if (!ignoreRef.current?.()) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      depth.release();
    };
  }, [active]);
}
