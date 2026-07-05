import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * The grid dimension (rows == cols == GRID_SIZE). Hard-coded 8 per the spec
 * (Notion/Google-Docs-style "insert table" hover grid). Exported so tests can
 * assert the total cell count without a magic number.
 */
export const GRID_SIZE = 8;

export interface TableGridPickerProps {
  /** Anchor position (screen coords) for the popup. */
  anchor: { x: number; y: number };
  /** Called when the user confirms a size (clicks a cell). */
  onSelect: (rows: number, cols: number) => void;
  /** Called when the user cancels (Esc, outside click, scroll, resize). */
  onCancel: () => void;
}

/**
 * An 8×8 hover-grid popup (Notion/Google-Docs "insert table") rendered into
 * `document.body` via a portal. The user hovers cells to preview a size; the
 * rectangle from the grid origin to the hovered cell is highlighted, and the
 * size label updates live. Clicking confirms, Esc / outside-click / scroll /
 * resize cancels.
 *
 * Positioning + dismiss follow `ContextMenu.tsx`: a `useLayoutEffect` measures
 * the popup and clamps it to the viewport, and a `useEffect` wires the four
 * dismiss listeners for the lifetime of the popup. The component is fully
 * controlled — the parent decides when to mount it and what to do with the
 * result; this just reports `onSelect` / `onCancel`.
 */
export function TableGridPicker({ anchor, onSelect, onCancel }: TableGridPickerProps) {
  const { t } = useTranslation("formatToolbar");
  const ref = useRef<HTMLDivElement>(null);
  // Hovered grid size, in 1-indexed rows × cols. Defaults to 1×1 (the origin
  // cell) so the label is never empty on first paint.
  const [hovered, setHovered] = useState<{ rows: number; cols: number }>({
    rows: 1,
    cols: 1,
  });
  // Final position after viewport clamping.
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: anchor.x, y: anchor.y });

  // Clamp the popup inside the viewport once it has been measured. Mirrors
  // ContextMenu.tsx's pattern; re-runs if the anchor moves.
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
  }, [anchor.x, anchor.y]);

  // Dismiss handlers — Esc, outside pointerdown, scroll, window resize. Wired
  // once on mount; follows ContextMenu.tsx exactly.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const onScrollOrResize = () => onCancel();
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
  }, [onCancel]);

  return createPortal(
    <div
      ref={ref}
      className="table-grid-picker"
      role="dialog"
      aria-label={t("tablePicker.label", { defaultValue: "Insert table" })}
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="table-grid-picker-label">
        {t("tablePicker.sizeRow", {
          count: hovered.rows,
          defaultValue: `{{count}} row${hovered.rows === 1 ? "" : "s"}`,
        })}{" × "}{t("tablePicker.sizeCol", {
          count: hovered.cols,
          defaultValue: `{{count}} col${hovered.cols === 1 ? "" : "s"}`,
        })}
      </div>
      <div
        className="table-grid"
        role="grid"
        // Reset hover to the origin when the pointer leaves the grid entirely,
        // so a stray hover-out doesn't leave a stale highlight.
        onMouseLeave={() => setHovered({ rows: 1, cols: 1 })}
      >
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => {
          const r = Math.floor(i / GRID_SIZE);
          const c = i % GRID_SIZE;
          const highlighted = r < hovered.rows && c < hovered.cols;
          return (
            <div
              key={i}
              role="gridcell"
              className={"table-grid-cell" + (highlighted ? " table-grid-cell-highlighted" : "")}
              // mouseEnter fires once per cell as the pointer enters it; cheaper
              // than onMouseMove on the grid + hit-testing.
              onMouseEnter={() => setHovered({ rows: r + 1, cols: c + 1 })}
              onClick={() => onSelect(r + 1, c + 1)}
            />
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
