import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { reactHarness } from "../../test/react";
import { useState } from "react";
import { useEscapeToClose } from "../useEscapeToClose";
import { acquireEscapeDepth } from "../escapeStack";

/**
 * Pins the modal-stack semantics of Escape handling: with two layers open,
 * one Escape press closes ONLY the topmost layer; after the top closes, the
 * next press closes the layer below. Regression for the stacked-modal bug
 * where one Escape closed every open dialog at once.
 */

function TwoDialogs({
  onCloseA,
  onCloseB,
}: {
  onCloseA: () => void;
  onCloseB: () => void;
}) {
  const [aOpen, setAOpen] = useState(true);
  const [bOpen, setBOpen] = useState(true);
  useEscapeToClose(aOpen, onCloseA);
  useEscapeToClose(bOpen, onCloseB);
  return (
    <>
      <button id="close-a" onClick={() => setAOpen(false)}>close A</button>
      {/* B mounted AFTER A → visually on top */}
      <button id="close-b" onClick={() => setBOpen(false)}>close B</button>
    </>
  );
}

const h = reactHarness();

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("escapeStack (stacked modal Escape semantics)", () => {
  it("one Escape closes only the topmost of two stacked layers", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    h.render(<TwoDialogs onCloseA={onCloseA} onCloseB={onCloseB} />);
    pressEscape();
    // B mounted later → topmost → it closes; A stays open.
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();
    h.unmount();
  });

  it("after the top layer unmounts, the lower one becomes topmost", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    let setBClosed: (v: boolean) => void = () => {};
    function Stack() {
      const [bOpen, setBOpen] = useState(true);
      setBClosed = setBOpen;
      useEscapeToClose(true, onCloseA);
      useEscapeToClose(bOpen, onCloseB);
      return null;
    }
    h.render(<Stack />);
    act(() => setBClosed(false)); // close B via UI (not Escape)
    expect(onCloseB).not.toHaveBeenCalled();
    pressEscape(); // now A is topmost
    expect(onCloseA).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("release() hands topmost-ness back to the previous ticket", () => {
    const a = acquireEscapeDepth();
    const b = acquireEscapeDepth();
    expect(a.isTopmost()).toBe(false);
    expect(b.isTopmost()).toBe(true);
    b.release();
    expect(a.isTopmost()).toBe(true);
    // Release is idempotent.
    b.release();
    expect(a.isTopmost()).toBe(true);
    a.release();
    expect(a.isTopmost()).toBe(false);
  });
});
