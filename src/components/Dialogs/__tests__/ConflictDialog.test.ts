import { describe, it, expect, beforeEach } from "vitest";

/**
 * ConflictDialog (§5.4 / §11.3) acceptance tests.
 *
 * The dialog's per-variant action matrix is what the spec calls out ("renders
 * the right actions per variant"). Rather than asserting on DOM (we don't have
 * @testing-library/react wired up), we assert on the PURE functions that drive
 * the button `disabled` props + the explanatory message — these are the single
 * source of truth the component reads, so locking their behavior pins the
 * rendered matrix.
 *
 *   - `canOverwrite(variant)`: gates the "Overwrite disk" button.
 *   - `conflictMessage(variant)`: the per-variant message above the actions.
 *
 * Plus the dialog store (open/close/setError) which controls visibility.
 */

const { canOverwrite, conflictMessage } = await import("../ConflictDialog");
const { useConflictDialogStore } = await import("../../../store/conflictDialogStore");
import type { ConflictState } from "../../../lib/types";

describe("ConflictDialog — action matrix per variant (§5.4)", () => {
  describe("canOverwrite", () => {
    it("is true for modified (disk is readable+writable)", () => {
      expect(canOverwrite("modified")).toBe(true);
    });

    it("is true for replaced (same content, new identity — disk is writable)", () => {
      expect(canOverwrite("replaced")).toBe(true);
    });

    it("is false for missing (the file is gone — nothing to overwrite)", () => {
      expect(canOverwrite("missing")).toBe(false);
    });

    it("is false for permission_changed (the file is unreadable/unwritable)", () => {
      expect(canOverwrite("permission_changed")).toBe(false);
    });

    it("is false for none (not in conflict — dialog wouldn't render anyway)", () => {
      expect(canOverwrite("none")).toBe(false);
    });
  });

  describe("conflictMessage", () => {
    const cases: Array<[ConflictState, RegExp]> = [
      ["modified", /changed on disk/i],
      ["missing", /deleted or moved/i],
      ["permission_changed", /read-only|inaccessible|permission/i],
      ["replaced", /replaced|identity/i],
    ];

    for (const [variant, expected] of cases) {
      it(`describes ${variant}`, () => {
        expect(conflictMessage(variant)).toMatch(expected);
        // Every active variant gets a NON-empty, distinct message.
        expect(conflictMessage(variant).length).toBeGreaterThan(10);
      });
    }

    it("returns an empty string for none", () => {
      expect(conflictMessage("none")).toBe("");
    });

    it("gives each active variant a distinct message (no copy-paste drift)", () => {
      const msgs = new Set(
        (["modified", "missing", "permission_changed", "replaced"] as ConflictState[]).map(
          (v) => conflictMessage(v),
        ),
      );
      expect(msgs.size).toBe(4);
    });
  });
});

describe("ConflictDialog store — visibility (§5.4)", () => {
  beforeEach(() => {
    // Reset to closed between tests so order doesn't bleed.
    useConflictDialogStore.getState().close();
  });

  it("opens for a given doc id, clearing any prior error", () => {
    useConflictDialogStore.getState().setError("boom");
    useConflictDialogStore.getState().open("doc-1");
    const s = useConflictDialogStore.getState();
    expect(s.openForId).toBe("doc-1");
    expect(s.error).toBeNull();
  });

  it("close() clears both the id and the error (the Later path)", () => {
    useConflictDialogStore.getState().open("doc-1");
    useConflictDialogStore.getState().setError("oops");
    useConflictDialogStore.getState().close();
    const s = useConflictDialogStore.getState();
    expect(s.openForId).toBeNull();
    expect(s.error).toBeNull();
  });

  it("setError records a message and keeps the dialog open for retry", () => {
    useConflictDialogStore.getState().open("doc-1");
    useConflictDialogStore.getState().setError("overwrite failed");
    const s = useConflictDialogStore.getState();
    expect(s.openForId).toBe("doc-1");
    expect(s.error).toBe("overwrite failed");
  });

  it("reopening for a different doc clears the stale error", () => {
    useConflictDialogStore.getState().open("doc-1");
    useConflictDialogStore.getState().setError("old");
    useConflictDialogStore.getState().open("doc-2");
    const s = useConflictDialogStore.getState();
    expect(s.openForId).toBe("doc-2");
    expect(s.error).toBeNull();
  });
});
