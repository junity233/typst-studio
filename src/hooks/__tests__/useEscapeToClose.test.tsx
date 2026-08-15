import { describe, it, expect, vi } from "vitest";
import { act } from "react";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../test/react";
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

const h = reactHarness();

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("useEscapeToClose", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    h.render(<Probe active onClose={onClose} />);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("no listener while inactive", () => {
    const onClose = vi.fn();
    h.render(<Probe active={false} onClose={onClose} />);
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    h.unmount();
  });

  it("ignoreWhile swallows Escape without closing (busy guard)", () => {
    const onClose = vi.fn();
    h.render(<Probe active onClose={onClose} ignoreWhile={() => true} />);
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    h.unmount();
  });

  it("re-arms when active flips true after mount", () => {
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
    h.render(<Toggle />);
    pressEscape(); // inactive — nothing to close
    expect(onClose).not.toHaveBeenCalled();
    const button = h.container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(open).toBe(true);
    pressEscape(); // now active — closes
    expect(onClose).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});
