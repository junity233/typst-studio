import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../test/react";
import { useDebounce, useDebouncedCallback } from "../useDebounce";

/**
 * Unit tests for the debounce primitives — the FIRST for this module.
 *
 * `useDebouncedCallback` is the editor's content-sync critical path (Monaco
 * `onChange` → backend `update_text`, 300ms): a timer that isn't cleared on
 * re-schedule, a stale callback firing, or lost latest-args semantics would
 * directly cause dropped keystrokes or an IPC flood. `useDebounce` backs the
 * StatusBar compile status and the Symbols/Packages filter inputs.
 *
 * Driven with fake timers + `act`: every `advanceTimersByTime` that can fire a
 * `setState` must run inside `act` so React flushes the re-render before the
 * assertion reads the probe output.
 */

/** Records the `useDebounce` output of every render, in order. */
const outputs: string[] = [];

function Probe({ value, delay }: { value: string; delay: number }) {
  const v = useDebounce(value, delay);
  outputs.push(v);
  return null;
}

/**
 * Exposes the latest `useDebouncedCallback` return value via `handle.current`,
 * so tests can invoke it after rerenders (a fresh render updates the handle —
 * the hook's `useCallback` identity only changes when `delay` does).
 */
const handle: {
  current: ((...args: unknown[]) => void) | null;
} = { current: null };

function CallbackProbe({
  cb,
  delay,
}: {
  cb: (...args: unknown[]) => void;
  delay: number;
}) {
  const fn = useDebouncedCallback(cb, delay);
  handle.current = fn;
  return null;
}

const h = reactHarness();

const cleanup = () => {
  h.cleanup();
  outputs.length = 0;
  handle.current = null;
};

describe("useDebounce(value, delay)", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("passes the initial value through immediately (no delay)", () => {
    h.render(<Probe value="a" delay={300} />);
    expect(outputs).toEqual(["a"]);
    // Even after the full delay with no changes, the value stays "a".
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(outputs).toEqual(["a"]);
  });

  it("lags behind value updates until the delay elapses", () => {
    h.render(<Probe value="a" delay={300} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    h.rerender(<Probe value="b" delay={300} />);
    // Not yet: the debounce window restarted with the new value.
    expect(outputs[outputs.length - 1]).toBe("a");
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(outputs[outputs.length - 1]).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(outputs[outputs.length - 1]).toBe("b");
  });

  it("coalesces rapid consecutive changes into one update on the last value", () => {
    h.render(<Probe value="a" delay={300} />);
    for (const v of ["b", "c", "d"]) {
      act(() => {
        vi.advanceTimersByTime(100);
      });
      h.rerender(<Probe value={v} delay={300} />);
    }
    // Each rerender resets the timer: 3 × 100ms < 300ms → still "a".
    expect(outputs[outputs.length - 1]).toBe("a");
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(outputs[outputs.length - 1]).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // One single flip straight to the LAST value — never "b"/"c".
    expect(outputs).toEqual(["a", "a", "a", "a", "d"]);
  });

  it("clears its timer on unmount (no update, no throw when time advances)", () => {
    h.render(<Probe value="a" delay={300} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    h.rerender(<Probe value="b" delay={300} />);
    // One pending debounce timer scheduled by the value change.
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    // Unmount ran the effect cleanup → the timer is cleared, so nothing can
    // fire a setDebounced into the dead root.
    expect(vi.getTimerCount()).toBe(0);
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(300);
      }),
    ).not.toThrow();
  });
});

describe("useDebouncedCallback(cb, delay)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("fires once after the quiet period, with the LAST call's args", () => {
    const cb = vi.fn();
    h.render(<CallbackProbe cb={cb} delay={300} />);
    handle.current!("first");
    handle.current!("second");
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(cb).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    // Latest-args semantics: "first" was superseded, not queued.
    expect(cb).toHaveBeenLastCalledWith("second");
  });

  it("resets the timer on every call (a burst fires exactly once)", () => {
    const cb = vi.fn();
    h.render(<CallbackProbe cb={cb} delay={300} />);
    handle.current!("x");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    handle.current!("x"); // restarts the window
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(cb).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("schedules with the NEW delay after the delay prop changes", () => {
    const cb = vi.fn();
    h.render(<CallbackProbe cb={cb} delay={100} />);
    handle.current!("old-delay");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cb).toHaveBeenCalledTimes(1);

    h.rerender(<CallbackProbe cb={cb} delay={300} />);
    handle.current!("new-delay");
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(cb).toHaveBeenCalledTimes(1); // old delay no longer applies
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith("new-delay");
  });

  it("a cb identity change does NOT reset the pending timer, but the LATEST cb fires", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    h.render(<CallbackProbe cb={cb1} delay={100} />);
    handle.current!("arg");
    act(() => {
      vi.advanceTimersByTime(50);
    });
    // Rerender with a different callback mid-window (fresh closure every
    // render is the normal case in components).
    h.rerender(<CallbackProbe cb={cb2} delay={100} />);
    // Complete the ORIGINAL 100ms window (only 50ms remain). If the rerender
    // had restarted the timer, nothing would have fired yet.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith("arg");
  });

  it("can schedule again after firing (timer slot is released)", () => {
    const cb = vi.fn();
    h.render(<CallbackProbe cb={cb} delay={100} />);
    handle.current!("one");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    // The fired timer must not block or double-fire on the next call.
    handle.current!("two");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(2, "two");
  });
});
