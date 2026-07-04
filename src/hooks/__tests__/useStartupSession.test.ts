import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RecoveryAvailablePayload } from "../../lib/types";
import { useRecoveryStore } from "../../store/recoveryStore";

/**
 * Issue 2 (launch latency): `useStartupSession` used to unconditionally sleep
 * 1500ms before session restore, even when no recovery would be offered. The
 * fix races a `recovery_available` listener against a SHORT timeout and
 * resolves as soon as the event lands (non-empty → offered; empty → none) or
 * the timeout elapses (none). The pure core of that race is
 * `raceRecoveryAvailable`, exercised here with fake timers + a stub subscribe
 * (no Tauri runtime needed).
 *
 * These tests pin the latency contract:
 *   - no event → resolves at the (short) timeout, NOT 1500ms;
 *   - empty event → resolves IMMEDIATELY (no wait);
 *   - non-empty event → resolves immediately as "offered".
 */

const { raceRecoveryAvailable } = await import("../useStartupSession");

/** A controllable subscribe stub: captures the handler and resolves the
 * registration promise. The test fires the handler (or never does) to drive
 * each scenario. Returns an unlisten spy. */
function makeStubSubscribe() {
  let captured: ((payload: RecoveryAvailablePayload) => void) | null = null;
  const unlisten = vi.fn();
  const subscribe = vi.fn(
    (handler: (payload: RecoveryAvailablePayload) => void) =>
      new Promise<() => void>((resolve) => {
        // Mimic onRecoveryAvailable's async registration.
        captured = handler;
        resolve(unlisten);
      }),
  );
  const emit = (payload: RecoveryAvailablePayload) => {
    if (captured) captured(payload);
  };
  return { subscribe, unlisten, emit };
}

describe("raceRecoveryAvailable (Issue 2 — launch latency)", () => {
  beforeEach(() => {
    // No recoverable data in the store (so the fast-path doesn't short-circuit).
    useRecoveryStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves 'none' at the short timeout when NO event arrives (not 1500ms)", async () => {
    vi.useFakeTimers();
    const { subscribe } = makeStubSubscribe();

    // 400ms ceiling (the production default). Old code waited 1500ms.
    const promise = raceRecoveryAvailable(subscribe, 400);
    const spy = vi.fn();
    promise.then(spy);

    // Well before the timeout → still pending.
    await vi.advanceTimersByTimeAsync(300);
    expect(spy).not.toHaveBeenCalled();

    // At the timeout → resolves 'none'. Crucially NOT at 1500ms.
    await vi.advanceTimersByTimeAsync(100);
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toBe("none");
  });

  it("resolves 'none' IMMEDIATELY when an EMPTY event arrives (no wait)", async () => {
    vi.useFakeTimers();
    const { subscribe, emit } = makeStubSubscribe();

    const promise = raceRecoveryAvailable(subscribe, 400);
    // Let the async subscribe registration complete so `emit` has the handler.
    await vi.advanceTimersByTimeAsync(0);

    // Backend emits an empty list → no recovery → resolve now.
    emit({ snapshots: [] });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe("none");
    // And we did NOT wait for the 400ms ceiling: advancing far past where the
    // timeout would have fired must not change anything (already settled).
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe("none");
  });

  it("resolves 'offered' IMMEDIATELY when a NON-EMPTY event arrives", async () => {
    vi.useFakeTimers();
    const { subscribe, emit } = makeStubSubscribe();

    const promise = raceRecoveryAvailable(subscribe, 400);
    await vi.advanceTimersByTimeAsync(0);

    emit({
      snapshots: [
        {
          documentId: "d1",
          title: "main.typ",
          canonicalPath: "/w/main.typ",
          capturedAt: 1_700_000_000_000,
          diskChanged: false,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe("offered");
  });

  it("fast-path: resolves 'offered' without subscribing when the store already has data", async () => {
    // Simulate the event having landed (and App.tsx populated the store)
    // BEFORE the race starts.
    useRecoveryStore.getState().offerRecovery([
      {
        documentId: "d1",
        title: "main.typ",
        canonicalPath: "/w/main.typ",
        capturedAt: 1_700_000_000_000,
        diskChanged: false,
      },
    ]);
    const { subscribe } = makeStubSubscribe();

    const outcome = await raceRecoveryAvailable(subscribe, 400);
    expect(outcome).toBe("offered");
    // The listener was never registered (nothing to wait for).
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("tears down the listener once resolved (no leak)", async () => {
    vi.useFakeTimers();
    const { subscribe, unlisten } = makeStubSubscribe();

    const promise = raceRecoveryAvailable(subscribe, 400);
    await vi.advanceTimersByTimeAsync(0); // registration completes
    expect(unlisten).not.toHaveBeenCalled();

    // Timeout fires → resolved + unlisten called.
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("the no-recovery path does NOT wait a long-recovery window (regression: was 1500ms)", async () => {
    // A direct latency assertion using real timers (bounded): the no-event
    // path must resolve around ~400ms, far under the old 1500ms. We allow
    // generous slack for CI scheduling but assert it's nowhere near 1500ms.
    const { subscribe } = makeStubSubscribe();
    const start = Date.now();
    const outcome = await raceRecoveryAvailable(subscribe, 400);
    const elapsed = Date.now() - start;
    expect(outcome).toBe("none");
    // Should be ~400ms; assert < 1000ms to robustly distinguish from 1500ms
    // without being flaky on a slow runner.
    expect(elapsed).toBeLessThan(1000);
  });
});
