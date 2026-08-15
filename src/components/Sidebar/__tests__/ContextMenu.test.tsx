import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../../test/react";
import { ContextMenu } from "../ContextMenu";
import { useContextMenuStore } from "../contextMenuStore";

const h = reactHarness();

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

function pointerDown(target: Element): void {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

beforeEach(() => {
  useContextMenuStore.setState({ current: null });
  h.render(<ContextMenu />);
});

afterEach(() => {
  h.cleanup();
  useContextMenuStore.setState({ current: null });
});

describe("ContextMenu portaled submenus", () => {
  it("lets a submenu leaf receive its click before closing the menu", () => {
    const onExportPdf = vi.fn();
    act(() => {
      useContextMenuStore.getState().open(
        [
          {
            type: "submenu",
            label: "Export",
            children: [
              {
                type: "action",
                label: "PDF",
                onSelect: onExportPdf,
              },
            ],
          },
        ],
        10,
        10,
      );
    });

    act(() => button("Export").click());
    const pdf = button("PDF");

    // Browser event order is pointerdown (captured by the outside-dismiss
    // listener) followed by click. The submenu is a body portal, so this is the
    // regression boundary: pointerdown must not dismiss it prematurely.
    act(() => pointerDown(pdf));
    expect(useContextMenuStore.getState().current).not.toBeNull();

    act(() => pdf.click());
    expect(onExportPdf).toHaveBeenCalledTimes(1);
    expect(useContextMenuStore.getState().current).toBeNull();
  });

  it("still closes for a true outside pointerdown", () => {
    act(() => {
      useContextMenuStore.getState().open(
        [{ type: "action", label: "Open", onSelect: vi.fn() }],
        10,
        10,
      );
    });

    act(() => pointerDown(document.body));
    expect(useContextMenuStore.getState().current).toBeNull();
  });
});
