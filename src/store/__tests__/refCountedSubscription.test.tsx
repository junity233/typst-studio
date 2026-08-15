import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
// React 19 only runs `act`'s effect-flushing behavior when this flag is set;
// we render via react-dom/client directly (no @testing-library/react). Mirrors
// useEscapeToClose.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { createRefCountedSubscription } from "../refCountedSubscription";

/**
 * Pins the shared ref-counted subscription lifecycle `lspStore` and
 * `tinymistInstallStore` both ride on: one fetch + one listen shared by
 * concurrent mounters, fetch payloads and events both funneling through
 * `apply`, release only when the last reader unmounts (microtask-deferred, so
 * a synchronous unmount+remount never tears the subscription down), and a
 * failed acquire being retryable by a later mount.
 */

interface Harness {
  fetch: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  setLoading: ReturnType<typeof vi.fn>;
  unlisten: ReturnType<typeof vi.fn>;
  useSubscription: () => void;
}

/**
 * A fresh factory + spies per test. `fetchImpl`/`listenImpl` let each test
 * control resolution; the refCount is a plain counter the factory sees
 * (mirroring `store.getState().refCount` in the real stores).
 */
function makeHarness(
  fetchImpl: () => Promise<unknown> = () => Promise.resolve({ seed: true }),
  listenImpl?: (onEvent: (p: unknown) => void) => Promise<() => void>,
): Harness {
  const fetch = vi.fn(fetchImpl);
  const unlisten = vi.fn();
  const listen = vi.fn(
    listenImpl ?? (() => Promise.resolve(unlisten)),
  );
  const apply = vi.fn();
  const setLoading = vi.fn();
  let refCount = 0;
  const { useSubscription } = createRefCountedSubscription<unknown>({
    fetch,
    listen,
    apply,
    timeoutLabel: "test fetch timed out",
    setLoading,
    setRefCount: (fn) => {
      refCount = Math.max(0, fn(refCount));
    },
    getRefCount: () => refCount,
  });
  return { fetch, listen, apply, setLoading, unlisten, useSubscription };
}

function Probe({ harness }: { harness: Harness }) {
  harness.useSubscription();
  return null;
}

function mount(harness: Harness, readers = 1): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <>
        {Array.from({ length: readers }, (_, i) => (
          <Probe key={i} harness={harness} />
        ))}
      </> as ReactElement,
    );
  });
  return { root, container };
}

/** Flush the microtask queue (release runs in `queueMicrotask`). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function unmount({ root, container }: { root: Root; container: HTMLDivElement }) {
  act(() => root.unmount());
  container.remove();
  await flushMicrotasks();
}

describe("createRefCountedSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first mount fetches once, listens once, and applies the seed", async () => {
    const h = makeHarness();
    const m = mount(h);
    await flushMicrotasks();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.listen).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith({ seed: true });
    await unmount(m);
  });

  it("concurrent readers share one acquire (no duplicate fetch/listen)", async () => {
    const h = makeHarness();
    const m = mount(h, 3);
    await flushMicrotasks();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.listen).toHaveBeenCalledTimes(1);
    await unmount(m);
  });

  it("release waits for the last reader: unlisten only at refCount 0", async () => {
    const h = makeHarness();
    const { root } = mount(h, 2);
    await flushMicrotasks();
    // Drop one reader — one remains, so the subscription must survive.
    act(() => {
      root.render(<Probe harness={h} />);
    });
    await flushMicrotasks();
    expect(h.unlisten).not.toHaveBeenCalled();
    // Drop the last reader — the deferred release unhooks the listener.
    act(() => {
      root.render(<></>);
    });
    await flushMicrotasks();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("a failed listen is retryable by a later mount (memo cleared)", async () => {
    let calls = 0;
    const unlisten = vi.fn();
    const h = makeHarness(
      () => Promise.resolve({}),
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("listen failed"))
          : Promise.resolve(unlisten);
      },
    );
    const first = mount(h);
    await flushMicrotasks();
    expect(calls).toBe(1);
    await unmount(first);
    // Remount: the rejected memo must not stick — acquire runs again.
    const second = mount(h);
    await flushMicrotasks();
    expect(calls).toBe(2);
    await unmount(second);
  });

  it("a hung fetch times out, clears loading, and still wires the listener", async () => {
    const unlisten = vi.fn();
    const h = makeHarness(
      () => new Promise(() => {}), // never resolves
      () => Promise.resolve(unlisten),
    );
    const m = mount(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.setLoading).toHaveBeenCalledWith(false);
    expect(h.listen).toHaveBeenCalledTimes(1);
    await unmount(m);
  });

  it("event payloads funnel through apply", async () => {
    let emit: ((p: unknown) => void) | null = null;
    const unlisten = vi.fn();
    const h = makeHarness(
      () => Promise.resolve({ seed: true }),
      (onEvent) => {
        emit = onEvent;
        return Promise.resolve(unlisten);
      },
    );
    const m = mount(h);
    await flushMicrotasks();
    act(() => {
      emit?.({ push: 1 });
    });
    expect(h.apply).toHaveBeenCalledWith({ push: 1 });
    await unmount(m);
  });
});
