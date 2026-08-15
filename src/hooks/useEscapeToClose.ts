import { useEffect, useRef } from "react";

/**
 * Close-on-Escape for modal portals: attach a window-level keydown listener
 * while `active`, calling `onClose` on Escape with `stopPropagation` so the
 * event never reaches handlers underneath (an editor, a palette behind the
 * dialog).
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
     * is in flight). The event is still stopped — the dialog owns the key
     * while it is open.
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!ignoreRef.current?.()) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
