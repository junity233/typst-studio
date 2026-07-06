import { describe, it, expect, vi } from "vitest";

/**
 * `useLspWorkspaceReconnect` decision helper.
 *
 * The React hook itself drives a live `lspStore` subscription + calls
 * `appLanguageClient.startWithFreshEndpoint()`, which transitively pulls Monaco
 * (widget CSS jsdom can't run) and a real WebSocket. The spec-critical
 * decision logic is the PURE helper `shouldReconnectOnStatus`, exercised here
 * directly.
 *
 * Returns `true` iff:
 *   1. the status object actually transitioned (not the same reference),
 *   2. the new status carries a STRICTLY NEWER generation than the previous
 *      one (any restart/crash bump that mints a fresh endpoint), AND
 *   3. `clientEverStarted` is true (the singleton has reached Ready at least
 *      once — so reconnecting is safe and won't open a second socket before the
 *      primary start() from MonacoEditor owns the live session).
 *
 * The gate (#3) keeps this hook inert until the primary `start()` completes:
 * before that, `everStartedSuccessfully()` is false and the helper returns
 * false even on a genuine generation advance. Once any client has reached
 * Ready, the same helper starts returning true and the reconnect just works —
 * including AFTER a `childCrash` (where `isRunning()` is already false but
 * `everStartedSuccessfully()` stays sticky-true).
 */

// Mock the appLanguageClient module so importing the hook file doesn't pull
// Monaco/vscode transports into jsdom. Only the pure helper is exercised here.
vi.mock("../../components/Editor/appLanguageClient", () => ({
  appLanguageClient: {
    isRunning: () => false,
    everStartedSuccessfully: () => false,
    start: vi.fn(),
    startWithFreshEndpoint: vi.fn(),
    subscribe: () => () => {},
    getGeneration: () => 0,
  },
}));

import { shouldReconnectOnStatus } from "../useLspWorkspaceReconnect";
import type { LspStatus } from "../../store/lspStore";

/** Build an `LspStatus` with defaults; override via `over`. */
function status(over: Partial<LspStatus> = {}): LspStatus {
  return {
    available: true,
    enabled: true,
    statusKind: "restarting",
    generation: 1,
    wsUrl: "ws://127.0.0.1:1/lsp/main/1?token=tok",
    restartReason: null,
    message: null,
    ...over,
  };
}

describe("shouldReconnectOnStatus — generation-advance reconnect decision", () => {
  it("returns true on a WorkspaceChange generation advance when the client has started", () => {
    const prev = status({ restartReason: null, statusKind: "running", generation: 1 });
    const current = status({ restartReason: "workspaceChange", generation: 2 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });

  it("returns true on a childCrash generation advance (reconnect after a crash)", () => {
    // A childCrash bumps the generation and leaves isRunning() false; but the
    // gate is everStartedSuccessfully (sticky), so the reconnect STILL fires —
    // this is the fix for "Server will not be restarted" dead-LSP-after-crash.
    const prev = status({ restartReason: null, statusKind: "running", generation: 2 });
    const current = status({ restartReason: "childCrash", generation: 3 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });

  it("returns true on a settingsChange generation advance", () => {
    const prev = status({ restartReason: null, generation: 2 });
    const current = status({ restartReason: "settingsChange", generation: 3 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });

  it("returns true on a manual-restart generation advance", () => {
    const prev = status({ restartReason: null, generation: 2 });
    const current = status({ restartReason: "manual", generation: 3 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });

  it("returns false when the generation did NOT advance (steady-state re-publish)", () => {
    // A follow-up Running publish carrying the SAME generation is not a new
    // endpoint — no reconnect.
    const prev = status({ restartReason: "workspaceChange", generation: 2 });
    const current = status({
      restartReason: null,
      generation: 2,
      statusKind: "running",
    });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(false);
  });

  it("returns false when the generation went BACKWARDS (stale event)", () => {
    // Forward-only: a stale event the store already gated out must also be
    // ignored here (defensive — shouldAcceptStatusEvent already drops it, but
    // this helper must not act on a regression even if it slipped through).
    const prev = status({ restartReason: "workspaceChange", generation: 5 });
    const current = status({ restartReason: "childCrash", generation: 4 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(false);
  });

  it("returns false when clientEverStarted is false (gate: primary start not done yet)", () => {
    // Before the first Ready, the hook must stay inert — MonacoEditor owns the
    // primary start(), and a speculative second socket would lose the
    // single-generation-single-connection race.
    const prev = status({ restartReason: null });
    const current = status({ restartReason: "workspaceChange", generation: 2 });
    expect(shouldReconnectOnStatus(prev, current, false)).toBe(false);
  });

  it("returns false when there is no transition (same status reference)", () => {
    // The effect can re-run on an unchanged store read; the helper must not
    // fire on a no-op.
    const s = status({ restartReason: "workspaceChange" });
    expect(shouldReconnectOnStatus(s, s, true)).toBe(false);
  });

  it("returns false on the very first run (prev === null)", () => {
    // On mount, prev is null. A generation advance already in the store at
    // mount is NOT a fresh transition we should react to — we only reconnect on
    // an advance we actually witness.
    const current = status({ restartReason: "workspaceChange" });
    expect(shouldReconnectOnStatus(null, current, true)).toBe(false);
  });

  it("returns true for consecutive generation advances (rapid restarts)", () => {
    // Two bumps back-to-back (e.g. workspaceChange then childCrash) each mint a
    // fresh endpoint and each warrant their own reconnect.
    const prev = status({ restartReason: "workspaceChange", generation: 2 });
    const current = status({ restartReason: "childCrash", generation: 3 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });
});
