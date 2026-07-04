import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * lspStore generation tracking (spec §6.4 / §16 / §17).
 *
 * The wire `lsp_status` payload does not carry a generation field yet (Task 7
 * adds it); for Task 5 generation is threaded through the `appLanguageClient`
 * singleton, which bumps on every restart / reconnect. The store mirrors that
 * number via `setGeneration` (forward-only) and exposes a pure
 * `shouldAcceptStatusEvent` gate consumers will use the moment the payload
 * carries a generation.
 *
 * The full `appLanguageClient` → store wiring runs through the ref-counted
 * `useLspStatus` React hook (a render effect), which is awkward to drive from a
 * store unit test; the spec-critical logic — the forward-only generation bump
 * and the stale-event gate — is exercised here directly against the store
 * actions and the pure helper.
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
} from "../lspStore";

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
