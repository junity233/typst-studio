import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useContextMenuStore } from "./contextMenuStore";

/**
 * A floating context menu rendered into `document.body` when the
 * `contextMenuStore` has a pending request. Positioned at the cursor, then
 * clamped to the viewport so it never overflows. Closes on: outside pointer
 * down, Escape, scroll, window resize, or any item selection.
 *
 * Styled per DESIGN.md: white canvas, hairline border, `radius.sm`, with the
 * same floating-surface shadow the existing `.dialog` uses.
 */
export function ContextMenu() {
  const current = useContextMenuStore((s) => s.current);
  const close = useContextMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  // Final position after viewport clamping (so the menu can flip/shift).
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Clamp the menu inside the viewport once it has been measured.
  useLayoutEffect(() => {
    if (current === null) return;
    const el = ref.current;
    const x = current.x;
    const y = current.y;
    if (el === null) {
      setPos({ x, y });
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 4;
    let nx = x;
    let ny = y;
    if (x + rect.width + margin > window.innerWidth) {
      nx = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (y + rect.height + margin > window.innerHeight) {
      ny = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ x: nx, y: ny });
  }, [current]);

  // Dismiss handlers — wired only while a menu is open.
  useEffect(() => {
    if (current === null) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScrollOrResize = () => close();
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
  }, [current, close]);

  if (current === null) return null;

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {current.items.map((item, i) =>
        item.type === "separator" ? (
          <div key={i} className="context-menu-separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={
              "context-menu-item" + (item.danger ? " context-menu-item-danger" : "")
            }
            disabled={item.disabled}
            onClick={() => {
              close();
              if (!item.disabled) item.onSelect();
            }}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
