import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TFunction } from "i18next";
import type { TinymistInstallStatus } from "../../../lib/types";

/**
 * Unit tests for StatusBar's six module-level mapping helpers — the display
 * and affordance matrix behind the permanent bottom bar:
 *
 * - `statusLabel`/`statusClass`: compile status → text / CSS class;
 * - `lspLabel`/`lspNeedsAction`: LSP lifecycle kind → label / Restart button;
 * - `unavailableInstallLabel`/`installActionable`: the tinymist managed-install
 *   states shown while the LSP is unavailable (Download / Retry vs. nothing).
 *
 * These branches decide whether the user can SEE and CLICK the Restart /
 * Download / Retry entries when the LSP drops or an install fails —
 * recoverability UI — and they interlock with the wire types
 * (`LspStatusKind`, `TinymistInstallStatus`), so a refactor regresses easily.
 * The helpers were previously module-private with zero tests; they were
 * exported purely to make this coverage possible (no behavior change).
 *
 * `t` is stubbed: it returns the key itself and records the interpolation
 * options so each case can assert both WHICH string was chosen and WHAT was
 * interpolated into it (e.g. that `status.compiledIn` received the duration).
 *
 * Importing StatusBar pulls in `lspStore`, which imports the
 * `appLanguageClient` singleton, which transitively loads Monaco (widget CSS
 * jsdom can't run). Mock the module — same approach as
 * `lspStore.generation.test.ts`; the mocked surface is only touched by the
 * `useLspStatus` hook, which these pure-helper tests never mount.
 */
vi.mock("../../Editor/appLanguageClient", () => ({
  appLanguageClient: {
    getGeneration: () => 0,
    subscribe: () => () => {},
  },
}));

import {
  statusLabel,
  statusClass,
  lspLabel,
  lspNeedsAction,
  unavailableInstallLabel,
  installActionable,
} from "../StatusBar";

/** One recorded `t(...)` call (key + interpolation options). */
interface TCall {
  key: string;
  opts: Record<string, unknown> | undefined;
}

const calls: TCall[] = [];

/**
 * A minimal `TFunction<"statusbar">` stand-in. Returns the raw key (stable,
 * greppable assertion target) and pushes the call onto `calls` for options
 * assertions via {@link lastOpts}.
 */
function stubT(): TFunction<"statusbar"> {
  return ((key: string, opts?: Record<string, unknown>) => {
    calls.push({ key, opts });
    return key;
  }) as unknown as TFunction<"statusbar">;
}

/** Interpolation options of the most recent `t(...)` call. */
function lastOpts(): Record<string, unknown> | undefined {
  return calls[calls.length - 1]?.opts;
}

/** A complete `TinymistInstallStatus` with falsy defaults, per-field overridden. */
function installStatus(
  over: Partial<TinymistInstallStatus> = {},
): TinymistInstallStatus {
  return {
    state: "notInstalled",
    inProgress: false,
    targetVersion: "",
    receivedBytes: 0,
    totalBytes: 0,
    installedVersion: null,
    installedPath: null,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe("statusLabel", () => {
  it("maps compiling to status.compiling", () => {
    expect(statusLabel(stubT(), "compiling", null)).toBe("status.compiling");
    expect(lastOpts()).toBeUndefined();
  });

  it("maps slow to status.compilingSlow", () => {
    expect(statusLabel(stubT(), "slow", null)).toBe("status.compilingSlow");
  });

  it("maps success with a duration to status.compiledIn, interpolating ms", () => {
    expect(statusLabel(stubT(), "success", 150)).toBe("status.compiledIn");
    expect(lastOpts()).toEqual({ ms: 150 });
  });

  it("maps success without a duration to status.compiled", () => {
    expect(statusLabel(stubT(), "success", null)).toBe("status.compiled");
  });

  it("maps error to status.compileFailed", () => {
    expect(statusLabel(stubT(), "error", 42)).toBe("status.compileFailed");
  });

  it("maps idle to status.ready", () => {
    expect(statusLabel(stubT(), "idle", null)).toBe("status.ready");
  });
});

describe("statusClass", () => {
  it("tints compiling and slow", () => {
    expect(statusClass("compiling")).toBe("statusbar-status--compiling");
    expect(statusClass("slow")).toBe("statusbar-status--compiling");
  });

  it("tints error", () => {
    expect(statusClass("error")).toBe("statusbar-status--error");
  });

  it("leaves idle and success unstyled", () => {
    expect(statusClass("idle")).toBe("");
    expect(statusClass("success")).toBe("");
  });
});

describe("lspLabel: managed-install states while unavailable", () => {
  it("shows a percentage while downloading with a known total", () => {
    const install = installStatus({
      state: "downloading",
      receivedBytes: 50,
      totalBytes: 200,
    });
    expect(lspLabel(stubT(), "unavailable", false, null, install)).toBe(
      "lsp.downloadingPercent",
    );
    // downloadPercent floors: floor(50 / 200 * 100) === 25.
    expect(lastOpts()).toEqual({ percent: 25 });
  });

  it("shows the plain downloading label when totalBytes is unknown", () => {
    const install = installStatus({ state: "downloading", totalBytes: 0 });
    expect(lspLabel(stubT(), "unavailable", false, null, install)).toBe(
      "lsp.downloading",
    );
  });

  it("shows verifying while the archive is verified", () => {
    const install = installStatus({ state: "verifying" });
    expect(lspLabel(stubT(), "unavailable", false, null, install)).toBe(
      "lsp.verifying",
    );
  });

  it("shows the download-failed label after an install failure", () => {
    const install = installStatus({ state: "failed", error: "boom" });
    expect(lspLabel(stubT(), "unavailable", false, null, install)).toBe(
      "lsp.downloadFailed",
    );
  });

  it("falls back to lsp.notInstalled when the install state adds nothing", () => {
    // install === null (never queried / auto-download disabled).
    expect(lspLabel(stubT(), "unavailable", false, null, null)).toBe(
      "lsp.notInstalled",
    );
    // Terminal/quiet install states also contribute no label.
    for (const state of ["notInstalled", "installed", "unsupported"] as const) {
      expect(
        lspLabel(stubT(), "unavailable", false, null, installStatus({ state })),
      ).toBe("lsp.notInstalled");
    }
  });
});

describe("lspLabel: lifecycle kinds", () => {
  it("maps disabled to lsp.off", () => {
    expect(lspLabel(stubT(), "disabled", true, null, null)).toBe("lsp.off");
  });

  it("maps failed with a message to lsp.message, interpolating it", () => {
    expect(lspLabel(stubT(), "failed", true, "manual restart required", null))
      .toBe("lsp.message");
    expect(lastOpts()).toEqual({ message: "manual restart required" });
  });

  it("maps failed without a message to lsp.restartNeeded", () => {
    expect(lspLabel(stubT(), "failed", true, null, null)).toBe(
      "lsp.restartNeeded",
    );
  });

  it("maps restarting / awaitingClient / running", () => {
    expect(lspLabel(stubT(), "restarting", true, null, null)).toBe(
      "lsp.reconnecting",
    );
    expect(lspLabel(stubT(), "awaitingClient", true, null, null)).toBe(
      "lsp.connecting",
    );
    expect(lspLabel(stubT(), "running", true, null, null)).toBe(
      "lsp.connected",
    );
  });

  it("only defers to the install state when unavailable AND not available", () => {
    // available=true: an "unavailable" event must not be overwritten by the
    // (possibly stale) install progress — the lifecycle branch wins.
    const install = installStatus({ state: "downloading", totalBytes: 100 });
    expect(lspLabel(stubT(), "unavailable", true, null, install)).toBe(
      "lsp.notInstalled",
    );
  });
});

describe("lspNeedsAction", () => {
  it("hides the Restart affordance for disabled / unavailable / running", () => {
    expect(lspNeedsAction("disabled", true)).toBe(false);
    expect(lspNeedsAction("unavailable", true)).toBe(false);
    // Unavailable + tinymist missing: restart won't help — early return.
    expect(lspNeedsAction("unavailable", false)).toBe(false);
    expect(lspNeedsAction("running", true)).toBe(false);
  });

  it("shows the Restart affordance for restarting / failed / awaitingClient", () => {
    expect(lspNeedsAction("restarting", true)).toBe(true);
    expect(lspNeedsAction("failed", true)).toBe(true);
    expect(lspNeedsAction("awaitingClient", true)).toBe(true);
  });
});

describe("unavailableInstallLabel", () => {
  it("returns null for a null install and for label-less states", () => {
    expect(unavailableInstallLabel(stubT(), null)).toBeNull();
    for (const state of ["notInstalled", "installed", "unsupported"] as const) {
      expect(
        unavailableInstallLabel(stubT(), installStatus({ state })),
      ).toBeNull();
    }
  });

  it("labels downloading (with and without a known total), verifying, failed", () => {
    expect(
      unavailableInstallLabel(
        stubT(),
        installStatus({ state: "downloading", receivedBytes: 10, totalBytes: 40 }),
      ),
    ).toBe("lsp.downloadingPercent");
    expect(lastOpts()).toEqual({ percent: 25 });
    expect(
      unavailableInstallLabel(stubT(), installStatus({ state: "downloading" })),
    ).toBe("lsp.downloading");
    expect(
      unavailableInstallLabel(stubT(), installStatus({ state: "verifying" })),
    ).toBe("lsp.verifying");
    expect(
      unavailableInstallLabel(stubT(), installStatus({ state: "failed" })),
    ).toBe("lsp.downloadFailed");
  });
});

describe("installActionable", () => {
  it("requires !available, statusKind unavailable and a non-null install", () => {
    const startable = installStatus({ state: "notInstalled" });
    // LSP available → no install entry at all.
    expect(installActionable("unavailable", true, startable)).toBe(false);
    // Any other lifecycle kind → not an install situation.
    expect(installActionable("failed", false, startable)).toBe(false);
    expect(installActionable("running", false, startable)).toBe(false);
    // No install snapshot → nothing to drive the button from.
    expect(installActionable("unavailable", false, null)).toBe(false);
  });

  it("is startable only for notInstalled and failed", () => {
    expect(
      installActionable("unavailable", false, installStatus({ state: "notInstalled" })),
    ).toBe(true);
    expect(
      installActionable("unavailable", false, installStatus({ state: "failed" })),
    ).toBe(true);
    // In-flight / terminal states have nothing to click.
    expect(
      installActionable("unavailable", false, installStatus({ state: "downloading" })),
    ).toBe(false);
    expect(
      installActionable("unavailable", false, installStatus({ state: "verifying" })),
    ).toBe(false);
    expect(
      installActionable("unavailable", false, installStatus({ state: "installed" })),
    ).toBe(false);
    expect(
      installActionable("unavailable", false, installStatus({ state: "unsupported" })),
    ).toBe(false);
  });
});
