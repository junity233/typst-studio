import { describe, it, expect, beforeEach } from "vitest";
import { useRecoveryStore, recoverRequiresCompareFirst } from "../recoveryStore";
import type { RecoverableInfo } from "../../lib/types";

/**
 * Recovery store (§5.1.3): the dialog state machine that backs RecoveryDialog.
 * Covers the offer/decide/auto-close lifecycle and the decision matrix that
 * the dialog renders (which the spec also requires a render test for; here we
 * test the pure store logic the dialog reads from).
 */

function snap(over: Partial<RecoverableInfo> = {}): RecoverableInfo {
  return {
    documentId: "d1",
    title: "main.typ",
    canonicalPath: "/w/main.typ",
    capturedAt: 1_700_000_000_000,
    diskChanged: false,
    ...over,
  };
}

describe("recoveryStore (§5.1.3)", () => {
  beforeEach(() => {
    useRecoveryStore.getState().reset();
  });

  it("offerRecovery opens the dialog when there are snapshots", () => {
    useRecoveryStore.getState().offerRecovery([snap()]);
    const s = useRecoveryStore.getState();
    expect(s.dialogOpen).toBe(true);
    expect(s.recoverable).toHaveLength(1);
  });

  it("offerRecovery with no snapshots does not open the dialog", () => {
    useRecoveryStore.getState().offerRecovery([]);
    expect(useRecoveryStore.getState().dialogOpen).toBe(false);
  });

  it("markDecided records the id but keeps the dialog open until all decided", () => {
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "a" }), snap({ documentId: "b" })]);
    useRecoveryStore.getState().markDecided("a");
    expect(useRecoveryStore.getState().dialogOpen).toBe(true);
    // Deciding the last one auto-closes.
    useRecoveryStore.getState().markDecided("b");
    expect(useRecoveryStore.getState().dialogOpen).toBe(false);
  });

  it("markDecided is idempotent (deciding twice does not pre-close)", () => {
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "a" }), snap({ documentId: "b" })]);
    useRecoveryStore.getState().markDecided("a");
    useRecoveryStore.getState().markDecided("a"); // duplicate
    expect(useRecoveryStore.getState().dialogOpen).toBe(true);
    useRecoveryStore.getState().markDecided("b");
    expect(useRecoveryStore.getState().dialogOpen).toBe(false);
  });

  it("close force-closes regardless of remaining decisions", () => {
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "a" }), snap({ documentId: "b" })]);
    useRecoveryStore.getState().close();
    expect(useRecoveryStore.getState().dialogOpen).toBe(false);
  });

  it("reset clears everything", () => {
    useRecoveryStore.getState().offerRecovery([snap()]);
    useRecoveryStore.getState().reset();
    const s = useRecoveryStore.getState();
    expect(s.recoverable).toEqual([]);
    expect(s.dialogOpen).toBe(false);
    expect(s.decidedIds.size).toBe(0);
    expect(s.recoveredIds.size).toBe(0);
  });

  it("tracks only snapshots that were actually recovered", () => {
    useRecoveryStore.getState().offerRecovery([
      snap({ documentId: "recovered" }),
      snap({ documentId: "discarded" }),
    ]);
    useRecoveryStore.getState().markRecovered("recovered");
    useRecoveryStore.getState().markDecided("recovered");
    useRecoveryStore.getState().markDecided("discarded");

    expect(useRecoveryStore.getState().recoveredIds).toEqual(
      new Set(["recovered"]),
    );
  });

  // --- Issue 1: disk-changed docs are unrecoverable until compared (§5.1.3) -
  //
  // The dialog gates Recover on `recoverRequiresCompareFirst(snap, compared)`.
  // These tests exercise the SHARED production helper (the same one the dialog
  // imports) plus the store's comparedIds contract, so a regression in either
  // the gating flag or the compare-unlock is caught.

  it("markCompared records the id and hasCompared reflects it", () => {
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "dc", diskChanged: true })]);
    expect(useRecoveryStore.getState().hasCompared("dc")).toBe(false);
    useRecoveryStore.getState().markCompared("dc");
    expect(useRecoveryStore.getState().hasCompared("dc")).toBe(true);
    // An unrelated id is unaffected.
    expect(useRecoveryStore.getState().hasCompared("other")).toBe(false);
  });

  it("disk-changed doc: Recover disabled initially, enabled after Compare (§5.1.3)", () => {
    const diskChanged = snap({ documentId: "dc", diskChanged: true });
    const store = () => useRecoveryStore.getState();
    // Before compare: mustCompare is true → Recover disabled.
    expect(
      recoverRequiresCompareFirst(diskChanged, store().hasCompared("dc")),
    ).toBe(true);
    // After the user clicks Compare (handleCompare calls markCompared on
    // success): mustCompare flips to false → Recover enabled.
    store().markCompared("dc");
    expect(
      recoverRequiresCompareFirst(diskChanged, store().hasCompared("dc")),
    ).toBe(false);
  });

  it("non-disk-changed and untitled docs never require compare", () => {
    const unchanged = snap({ documentId: "uc", diskChanged: false });
    const untitled = snap({ documentId: "ut", canonicalPath: null, diskChanged: true });
    // Neither requires compare regardless of compared state.
    expect(recoverRequiresCompareFirst(unchanged, false)).toBe(false);
    expect(recoverRequiresCompareFirst(untitled, false)).toBe(false);
  });

  it("offerRecovery resets comparedIds so a stale compare can't unlock a fresh offer", () => {
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "dc", diskChanged: true })]);
    useRecoveryStore.getState().markCompared("dc");
    expect(useRecoveryStore.getState().hasCompared("dc")).toBe(true);
    // A fresh offer must clear the stale compare.
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "dc", diskChanged: true })]);
    expect(useRecoveryStore.getState().hasCompared("dc")).toBe(false);
  });

  it("markCompared is idempotent (comparing twice stays compared)", () => {
    useRecoveryStore.getState().offerRecovery([snap({ documentId: "dc", diskChanged: true })]);
    useRecoveryStore.getState().markCompared("dc");
    useRecoveryStore.getState().markCompared("dc");
    expect(useRecoveryStore.getState().comparedIds.size).toBe(1);
    expect(useRecoveryStore.getState().hasCompared("dc")).toBe(true);
  });
});
