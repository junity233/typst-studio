import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * lspStore generation tracking (spec §6.4 / §16 / §17).
 *
 * Task 7 threads generation onto the wire `lsp_status` payload, so the store
 * now drives its generation from the wire (forward-only via
 * `shouldAcceptStatusEvent`, applied in `applyPayload`) — with the
 * `appLanguageClient` singleton remaining a secondary feed. These tests
 * exercise: the pure stale-event gate, the forward-only `setGeneration`, and
 * the wire-payload-driven generation (stale dropped, current/future accepted).
 *
 * The full `appLanguageClient` → store wiring runs through the ref-counted
 * `useLspStatus` React hook (a render effect), which is awkward to drive from a
 * store unit test; the spec-critical logic is exercised here directly against
 * the store actions and the pure helpers.
 *
 * `lspStore` imports the `appLanguageClient` singleton, which transitively
 * pulls Monaco (widget CSS that jsdom can't run). We mock the module so the
 * store loads under jsdom; the mocked surface is only touched by the
 * `useLspStatus` hook, which these store-action tests never mount.
 */
vi.mock("../../components/Editor/appLanguageClient", () => ({
  appLanguageClient: {
    getGeneration: () => 0,
    subscribe: () => () => {},
  },
}));

import {
  useLspStore,
  shouldAcceptStatusEvent,
  applyPayload,
  payloadToStatus,
} from "../lspStore";
import type { LspStatusPayload } from "../../lib/types";

/** Build a wire payload for tests (defaults to a Running gen-1 status). */
function payload(
  generation: number,
  over: Partial<LspStatusPayload> = {},
): LspStatusPayload {
  return {
    available: true,
    enabled: true,
    status: "running",
    generation,
    wsUrl: `ws://127.0.0.1:1/lsp/main/${generation}?token=tok`,
    restartReason: null,
    message: null,
    ...over,
  };
}

describe("shouldAcceptStatusEvent (§6.4 generation gate)", () => {
  it("accepts an event whose generation equals the current one", () => {
    expect(shouldAcceptStatusEvent(0, 0)).toBe(true);
    expect(shouldAcceptStatusEvent(5, 5)).toBe(true);
  });

  it("accepts a strictly-newer generation", () => {
    expect(shouldAcceptStatusEvent(2, 1)).toBe(true);
    expect(shouldAcceptStatusEvent(10, 3)).toBe(true);
  });

  it("drops a strictly-older generation", () => {
    expect(shouldAcceptStatusEvent(0, 1)).toBe(false);
    expect(shouldAcceptStatusEvent(3, 5)).toBe(false);
  });

  it("boundary: just-below is dropped, equal is accepted", () => {
    expect(shouldAcceptStatusEvent(4, 5)).toBe(false);
    expect(shouldAcceptStatusEvent(5, 5)).toBe(true);
  });
});

describe("lspStore generation (§16)", () => {
  beforeEach(() => {
    // Reset the generation back to 0 between tests.
    useLspStore.setState({ generation: 0 });
  });

  it("defaults to generation 0", () => {
    expect(useLspStore.getState().generation).toBe(0);
  });

  it("setGeneration moves the generation forward", () => {
    useLspStore.getState().setGeneration(3);
    expect(useLspStore.getState().generation).toBe(3);
    useLspStore.getState().setGeneration(7);
    expect(useLspStore.getState().generation).toBe(7);
  });

  it("setGeneration is forward-only — an older value does not rewind", () => {
    useLspStore.getState().setGeneration(5);
    useLspStore.getState().setGeneration(2);
    expect(useLspStore.getState().generation).toBe(5);
  });

  it("setGeneration with an equal value is a no-op (no rewind, no churn)", () => {
    useLspStore.getState().setGeneration(5);
    const before = useLspStore.getState();
    useLspStore.getState().setGeneration(5);
    // No state transition: identity stays stable.
    expect(useLspStore.getState()).toBe(before);
  });

  it("setGeneration(0) after a bump does NOT rewind to 0", () => {
    useLspStore.getState().setGeneration(4);
    useLspStore.getState().setGeneration(0);
    expect(useLspStore.getState().generation).toBe(4);
  });
});

describe("applyPayload — wire-payload-driven generation (Task 7)", () => {
  beforeEach(() => {
    // Reset the generation + status back to baseline between tests.
    useLspStore.setState({ generation: 0, status: payloadToStatus(payload(0)) });
  });

  it("applies a current-generation wire payload (accepts equal)", () => {
    useLspStore.getState().setGeneration(3);
    const before = useLspStore.getState().status;
    applyPayload(payload(3, { status: "running" }));
    expect(useLspStore.getState().generation).toBe(3);
    expect(useLspStore.getState().status.statusKind).toBe("running");
    // Sanity: the status object changed.
    expect(useLspStore.getState().status).not.toBe(before);
  });

  it("applies a future-generation wire payload (accepts newer)", () => {
    useLspStore.getState().setGeneration(3);
    applyPayload(payload(7, { status: "restarting", restartReason: "manual" }));
    expect(useLspStore.getState().generation).toBe(7);
    expect(useLspStore.getState().status.statusKind).toBe("restarting");
    expect(useLspStore.getState().status.restartReason).toBe("manual");
  });

  it("drops a stale wire payload (strictly-older generation)", () => {
    // Store is at gen 5; a payload claiming gen 3 is stale → dropped, no churn.
    useLspStore.getState().setGeneration(5);
    const before = useLspStore.getState();
    applyPayload(payload(3, { status: "failed" }));
    // Generation NOT rewound.
    expect(useLspStore.getState().generation).toBe(5);
    // Status NOT overwritten (the stale event did not clobber the live view).
    expect(useLspStore.getState().status).toBe(before.status);
  });

  it("payloadToStatus renames wire `status` → `statusKind` and normalizes nulls", () => {
    const s = payloadToStatus(payload(2, {
      status: "awaitingClient",
      // wire uses `null | undefined` for optional fields; internal normalizes to `null`.
    }));
    expect(s.statusKind).toBe("awaitingClient");
    expect(s.generation).toBe(2);
    expect(s.restartReason).toBeNull();
    expect(s.message).toBeNull();
    // And a payload carrying a reason round-trips it.
    const s2 = payloadToStatus(payload(4, { restartReason: "childCrash", message: "boom" }));
    expect(s2.restartReason).toBe("childCrash");
    expect(s2.message).toBe("boom");
  });
});
