import { useLayoutEffect, useState } from "react";

/**
 * Position a floating, portal-rendered popup (context menu, hover grid picker)
 * at `anchor` and clamp it inside the viewport once it has been measured.
 * Returns the final `{ x, y }` for the popup's `left`/`top` style.
 *
 * `anchor` is in screen/viewport coordinates. `ref` is the popup element — the
 * first layout effect measures it; until then (and while it stays unmeasurable)
 * the popup renders at the raw anchor. A 4 px margin keeps the popup from
 * touching the viewport edges. Re-runs when the anchor moves.
 */
export function useClampedPopupPosition(
  anchor: { x: number; y: number },
  ref: React.RefObject<HTMLElement | null>,
): { x: number; y: number } {
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) {
      setPos({ x: anchor.x, y: anchor.y });
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 4;
    let nx = anchor.x;
    let ny = anchor.y;
    if (anchor.x + rect.width + margin > window.innerWidth) {
      nx = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (anchor.y + rect.height + margin > window.innerHeight) {
      ny = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ x: nx, y: ny });
  }, [anchor.x, anchor.y, ref]);

  return pos;
}
