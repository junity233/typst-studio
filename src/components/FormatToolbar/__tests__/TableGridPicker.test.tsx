import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// React 19 only runs `act`'s effect-flushing + warning behavior when this flag
// is set. We render via react-dom/client directly (no @testing-library/react),
// so opt in here. Mirrors FormatToolbar.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { TableGridPicker } from "../TableGridPicker";

/**
 * Format Toolbar Task 5 — `TableGridPicker` popup tests.
 *
 * Renders via `react-dom/client` (jsdom) like FormatToolbar.test.tsx and asserts
 * on the DOM directly. The picker is portal-rendered, so cells land in
 * `document.body`, not the render container. Covers:
 *  - 8×8 grid renders (64 cells).
 *  - hover highlights the rectangle from origin to the hovered cell.
 *  - the size label updates on hover (rows × cols).
 *  - click → onSelect(rows, cols).
 *  - Esc → onCancel. Outside pointerdown → onCancel.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (ui: React.ReactElement): HTMLDivElement => {
  container = document.createElement("div");
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(ui);
  });
  return container;
};

const cleanup = () => {
  if (root !== null && container !== null) {
    const r = root;
    act(() => {
      r.unmount();
    });
    container.remove();
  }
  root = null;
  container = null;
};

const ANCHOR = { x: 100, y: 200 };

/** nth cell in the grid (0-indexed across all 64, in document order). */
const cell = (n: number): HTMLElement => {
  const el = document.body.querySelector<HTMLElement>(
    `.table-grid-cell:nth-child(${n + 1})`,
  );
  if (!el) throw new Error(`cell ${n} not found`);
  return el;
};

describe("TableGridPicker", () => {
  beforeEach(cleanup);

  it("renders an 8×8 grid (64 cells) in a portal", () => {
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={() => {}} />,
    );
    const cells = document.body.querySelectorAll(".table-grid-cell");
    expect(cells.length).toBe(64);
  });

  it("highlights the rectangle from origin to the hovered cell", () => {
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={() => {}} />,
    );
    // Hover cell at grid position (r=2, c=3) → index = 2*8 + 3 = 19.
    // Rectangle = (r+1)×(c+1) = 3×4 = 12 highlighted cells (rows<3 && cols<4).
    // React synthesizes onMouseEnter from native `mouseover`, so dispatch that.
    act(() => {
      cell(19).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const highlighted = document.body.querySelectorAll(
      ".table-grid-cell-highlighted",
    );
    expect(highlighted.length).toBe(12);
  });

  it("updates the size label to 'rows × cols' on hover", () => {
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={() => {}} />,
    );
    const label = () => document.body.querySelector(".table-grid-picker-label");
    // Initial state: 1 × 1 (the origin cell is hovered on first paint).
    expect(label()?.textContent).toContain("1");

    act(() => {
      cell(19).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    // r=2, c=3 → (r+1)×(c+1) = 3 rows × 4 cols.
    expect(label()?.textContent).toContain("3");
    expect(label()?.textContent).toContain("4");
  });

  it("click on a cell → onSelect(rows, cols) with the hovered size", () => {
    const onSelect = vi.fn();
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={onSelect} onCancel={() => {}} />,
    );
    // Hover cell (r=1, c=1) → index 9 → size 2×2.
    act(() => {
      cell(9).dispatchEvent(new MouseEvent("mouseEnter", { bubbles: true }));
    });
    act(() => {
      cell(9).click();
    });
    expect(onSelect).toHaveBeenCalledWith(2, 2);
  });

  it("Escape key → onCancel", () => {
    const onCancel = vi.fn();
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={onCancel} />,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("pointerdown outside the picker → onCancel", () => {
    const onCancel = vi.fn();
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={onCancel} />,
    );
    // A pointerdown on document.body (which is not inside the picker portal's
    // root) should trigger dismiss. The picker is a child of body; a pointerdown
    // directly on body is "outside" the picker element. jsdom has no PointerEvent
    // constructor — MouseEvent has the same shape the handler inspects (target +
    // type).
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("pointerdown inside the picker does NOT cancel", () => {
    const onCancel = vi.fn();
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={onCancel} />,
    );
    act(() => {
      cell(0).dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("positions itself at the clamped anchor via inline left/top", () => {
    render(
      <TableGridPicker anchor={ANCHOR} onSelect={() => {}} onCancel={() => {}} />,
    );
    const el = document.body.querySelector<HTMLElement>(".table-grid-picker");
    expect(el).not.toBeNull();
    // The anchor x/y are used as the starting position; jsdom doesn't do real
    // layout so getBoundingClientRect width/height are 0, meaning no clamping
    // occurs and the final position equals the anchor.
    expect(el!.style.left).toBe("100px");
    expect(el!.style.top).toBe("200px");
  });
});
