import { describe, it, expect, vi } from "vitest";

/**
 * Task 8 part C / D — `useLspWorkspaceReconnect` decision helper.
 *
 * The React hook itself drives a live `lspStore` subscription + calls
 * `appLanguageClient.start()`, which transitively pulls Monaco (widget CSS
 * jsdom can't run) and a real WebSocket. The spec-critical decision logic is
 * the PURE helper `shouldReconnectOnStatus`, exercised here directly:
 *
 * Returns `true` iff:
 *   1. the status object actually transitioned (not the same reference),
 *   2. the new status carries `restartReason === "workspaceChange"`, AND
 *   3. `appLanguageClient.isRunning()` is true (the Phase-C gate — the singleton
 *      is the active client, so reconnecting won't open a second socket against
 *      the wrapper's still-live session).
 *
 * The Phase-C gate (#3) is what keeps this hook inert today: nothing starts
 * `appLanguageClient` yet, so `isRunning()` is false and the helper returns
 * false even on a genuine workspace-change event. The day the rewire lands,
 * the same helper starts returning true and the reconnect just works.
 */

// Mock the appLanguageClient module so importing the hook file doesn't pull
// Monaco/vscode transports into jsdom. Only the pure helper is exercised here.
vi.mock("../../components/Editor/appLanguageClient", () => ({
  appLanguageClient: {
    isRunning: () => false,
    start: vi.fn(),
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

describe("shouldReconnectOnStatus — §14 workspace-change reconnect decision", () => {
  it("returns true on a WorkspaceChange transition when the client is running", () => {
    const prev = status({ restartReason: null, statusKind: "running" });
    const current = status({ restartReason: "workspaceChange", generation: 2 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });

  it("returns false when restartReason is NOT workspaceChange (e.g. childCrash)", () => {
    const prev = status({ restartReason: null });
    const current = status({ restartReason: "childCrash", generation: 2 });
    // Even with the client running, a crash-driven restart is not a workspace
    // change — the existing client will recover on its own; no workspace-aware
    // re-initialize is needed.
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(false);
  });

  it("returns false when restartReason is workspaceChange but client is NOT running (Phase-C gate)", () => {
    const prev = status({ restartReason: null });
    const current = status({ restartReason: "workspaceChange", generation: 2 });
    // This is the INERT-today case: the singleton isn't the active client yet,
    // so we must NOT speculatively start it (would open a second socket against
    // the wrapper's live session). The hook logs the intent but no-ops.
    expect(shouldReconnectOnStatus(prev, current, false)).toBe(false);
  });

  it("returns false when there is no transition (same status reference)", () => {
    // The effect can re-run on an unchanged store read; the helper must not
    // fire on a no-op.
    const s = status({ restartReason: "workspaceChange" });
    expect(shouldReconnectOnStatus(s, s, true)).toBe(false);
  });

  it("returns false on the very first run (prev === null), even for a workspaceChange status", () => {
    // On mount, prev is null. A workspaceChange status already in the store at
    // mount is NOT a fresh transition we should react to — we only reconnect on
    // a transition INTO the reason, which can't have happened before mount.
    const current = status({ restartReason: "workspaceChange" });
    expect(shouldReconnectOnStatus(null, current, true)).toBe(false);
  });

  it("returns false when current.restartReason is null (steady-state status)", () => {
    const prev = status({ restartReason: "workspaceChange", generation: 2 });
    const current = status({ restartReason: null, generation: 2, statusKind: "running" });
    // The follow-up Running publish after the restart carries no reason — not a
    // new workspace change. (The reconnect already happened on the Restarting
    // publish that carried the reason.)
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(false);
  });

  it("returns true for consecutive WorkspaceChange transitions (rapid open+switch)", () => {
    // Two workspace changes back-to-back each warrant their own reconnect.
    const prev = status({ restartReason: "workspaceChange", generation: 2 });
    const current = status({ restartReason: "workspaceChange", generation: 3 });
    expect(shouldReconnectOnStatus(prev, current, true)).toBe(true);
  });
});
