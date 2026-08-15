import { useEffect, useRef } from "react";

/**
 * The dismiss wiring shared by floating portal popups: outside pointer down
 * (capture phase), Escape, scroll (capture), and window resize all call
 * `onDismiss`. Previously hand-rolled per popup.
 *
 * `isInside` distinguishes pointer-downs on the popup (or its portaled
 * descendants) from outside ones — only outside pointer-downs dismiss.
 *
 * The callbacks live in refs so the listeners attach/detach only when `active`
 * flips, not on every re-render with a fresh closure.
 */
export function usePopupDismiss(
  active: boolean,
  onDismiss: () => void,
  isInside: (target: EventTarget | null) => boolean,
): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const isInsideRef = useRef(isInside);
  isInsideRef.current = isInside;

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!isInsideRef.current(e.target)) onDismissRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissRef.current();
    };
    const onScrollOrResize = () => onDismissRef.current();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [active]);
}
