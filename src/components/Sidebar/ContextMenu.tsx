import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useContextMenuStore, type MenuItem } from "./contextMenuStore";

/**
 * A floating context menu rendered into `document.body` when the
 * `contextMenuStore` has a pending request. Positioned at the cursor, then
 * clamped to the viewport so it never overflows. Closes on: outside pointer
 * down, Escape, scroll, window resize, or any leaf item selection.
 *
 * Submenu items (`type: "submenu"`) open a nested menu on hover, positioned to
 * the right of the parent item (flipped to the left if it would overflow).
 * Selecting any leaf item inside a submenu closes the whole chain.
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
      <MenuList items={current.items} closeAll={close} />
    </div>,
    document.body,
  );
}

/**
 * The delay before a hovered-out submenu collapses. Lets the pointer travel
 * the gap between a submenu row and its panel without the panel snapping shut.
 * Matches the perceptual budget common native menus use.
 */
const SUBMENU_CLOSE_DELAY_MS = 150;

/**
 * Renders a list of menu items. Used for both the top-level menu and nested
 * submenu panels. `closeAll` closes the entire menu chain (called when a leaf
 * action is selected).
 */
function MenuList({
  items,
  closeAll,
}: {
  items: MenuItem[];
  closeAll: () => void;
}) {
  // The index of the submenu currently expanded, if any. Only one submenu is
  // open at a time per menu level.
  const [openSub, setOpenSub] = useState<number | null>(null);
  // A pending-close timer for the open submenu. Cleared when the pointer
  // re-enters the submenu row or its panel.
  const closeTimer = useRef<number | null>(null);

  const clearTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  // Cancel any pending submenu close on unmount.
  useEffect(() => clearTimer, []);

  /** Expand submenu `i` immediately, cancelling any pending close. */
  const showSub = (i: number) => {
    clearTimer();
    setOpenSub(i);
  };
  /** Schedule submenu collapse; cancellable by a re-enter within the delay. */
  const scheduleHide = (i: number) => {
    clearTimer();
    closeTimer.current = window.setTimeout(() => {
      setOpenSub((cur) => (cur === i ? null : cur));
      closeTimer.current = null;
    }, SUBMENU_CLOSE_DELAY_MS);
  };

  return (
    <div className="context-menu-list">
      {items.map((item, i) =>
        item.type === "separator" ? (
          <div key={i} className="context-menu-separator" />
        ) : item.type === "submenu" ? (
          <SubmenuRow
            key={i}
            label={item.label}
            children={item.children}
            expanded={openSub === i}
            onEnter={() => showSub(i)}
            onLeave={() => scheduleHide(i)}
            closeAll={closeAll}
          />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={
              "context-menu-item" +
              (item.danger ? " context-menu-item-danger" : "")
            }
            disabled={item.disabled}
            // Scanning onto a plain item collapses any open sibling submenu.
            onPointerEnter={() => {
              clearTimer();
              setOpenSub(null);
            }}
            onClick={() => {
              closeAll();
              if (!item.disabled) item.onSelect();
            }}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/**
 * A row that owns a nested submenu panel. On hover it renders a
 * `SubmenuPanel` (a second floating `context-menu`) anchored to the row's
 * right edge (or left edge if it would overflow the viewport). Hovering the
 * panel keeps it open; leaving both row and panel (for longer than the close
 * delay) collapses it.
 */
function SubmenuRow({
  label,
  children,
  expanded,
  onEnter,
  onLeave,
  closeAll,
}: {
  label: string;
  children: MenuItem[];
  expanded: boolean;
  onEnter: () => void;
  onLeave: () => void;
  closeAll: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  // An empty children list disables the submenu (e.g. "No recent workspaces").
  const disabled = children.length === 0;

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        className="context-menu-item context-menu-submenu-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={expanded && !disabled}
        onPointerEnter={() => {
          if (!disabled) onEnter();
        }}
        onPointerLeave={onLeave}
        onClick={() => {
          // Click also opens (useful for touch / precision pointers).
          if (!disabled) onEnter();
        }}
      >
        <span className="context-menu-label">{label}</span>
        <span className="context-menu-submenu-arrow" aria-hidden="true">
          ›
        </span>
      </button>
      {expanded && !disabled && rowRef.current && (
        <SubmenuPanel
          items={children}
          anchor={rowRef.current}
          closeAll={closeAll}
          onEnter={onEnter}
        />
      )}
    </>
  );
}

/**
 * A floating submenu panel anchored to the right (or left) of its trigger row.
 * Portaled to `document.body` and clamped to the viewport. Hovering it keeps
 * the submenu open (counteracting the row's onPointerLeave via `onEnter`).
 */
function SubmenuPanel({
  items,
  anchor,
  closeAll,
  onEnter,
}: {
  items: MenuItem[];
  anchor: HTMLElement;
  closeAll: () => void;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    const ar = anchor.getBoundingClientRect();
    // The owning menu panel (the .context-menu that contains `anchor`). Used
    // as the horizontal anchor so the submenu sits OUTSIDE the parent panel
    // instead of overlapping it — placing at the trigger row's own edge would
    // make the submenu cover the parent's far-side items when flipped left.
    const parentPanel = anchor.closest(".context-menu");
    const pr = parentPanel?.getBoundingClientRect() ?? ar;
    if (el === null) {
      // Default to the right of the parent until measured.
      setPos({ x: pr.right, y: ar.top });
      return;
    }
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const margin = 4;
    // Prefer the right side (flush with the parent's right edge + gap); flip
    // to the left (parent's left edge − width − gap) only when the right side
    // would overflow the viewport. Either way the panel never overlaps the
    // parent: on the right it starts AT/after pr.right; on the left it ends
    // BEFORE pr.left.
    let x: number;
    const fitsRight = pr.right + gap + rect.width + margin <= window.innerWidth;
    if (fitsRight) {
      x = pr.right + gap;
    } else {
      x = pr.left - gap - rect.width;
    }
    x = Math.max(margin, x);
    // Vertically clamp to the viewport.
    let y = ar.top;
    if (y + rect.height + margin > window.innerHeight) {
      y = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ x, y });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className="context-menu context-menu-submenu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={onEnter}
    >
      <MenuList items={items} closeAll={closeAll} />
    </div>,
    document.body,
  );
}
