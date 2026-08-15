import { describe, it, expect, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
// React 19 only runs `act`'s effect-flushing behavior when this flag is set;
// we render via react-dom/client directly (no @testing-library/react). Mirrors
// useDebounce.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { useState } from "react";
import { useEscapeToClose } from "../useEscapeToClose";

/**
 * Pins the shared Escape-to-close contract every modal relies on: the
 * listener exists only while active, Escape triggers close, `ignoreWhile`
 * swallows the key without closing (busy dialogs must not accidentally adopt
 * "Later"/cancel semantics), and the listener re-arms when active flips.
 */

function Probe({
  active,
  onClose,
  ignoreWhile,
}: {
  active: boolean;
  onClose: () => void;
  ignoreWhile?: () => boolean;
}) {
  useEscapeToClose(active, onClose, { ignoreWhile });
  return null;
}

function mount(
  element: ReactElement,
  container: HTMLElement,
): Root {
  const root = createRoot(container);
  act(() => root.render(element));
  return root;
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("useEscapeToClose", () => {
  it("closes on Escape", () => {
    const container = document.createElement("div");
    const onClose = vi.fn();
    const root = mount(<Probe active onClose={onClose} />, container);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("no listener while inactive", () => {
    const container = document.createElement("div");
    const onClose = vi.fn();
    const root = mount(<Probe active={false} onClose={onClose} />, container);
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("ignoreWhile swallows Escape without closing (busy guard)", () => {
    const container = document.createElement("div");
    const onClose = vi.fn();
    const root = mount(
      <Probe active onClose={onClose} ignoreWhile={() => true} />,
      container,
    );
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("re-arms when active flips true after mount", () => {
    const container = document.createElement("div");
    const onClose = vi.fn();
    let open = false;
    function Toggle() {
      const [active, setActive] = useState(false);
      useEscapeToClose(active, onClose);
      open = active;
      return (
        <button onClick={() => setActive(true)}>open</button>
      );
    }
    const root = mount(<Toggle />, container);
    pressEscape(); // inactive — nothing to close
    expect(onClose).not.toHaveBeenCalled();
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(open).toBe(true);
    pressEscape(); // now active — closes
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
