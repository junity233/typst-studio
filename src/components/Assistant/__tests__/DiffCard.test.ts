import { describe, it, expect } from "vitest";

/**
 * DiffCard acceptance tests — pure-function level, following the codebase's
 * no-DOM-render convention (see ConflictDialog.test.ts).
 *
 * `contextWindow` is the modal's context trimmer; the diff itself now comes
 * from `unifiedDiff` (lib/diff), whose multi-block correctness is covered in
 * lib/__tests__/diff.test.ts. What needs pinning HERE is the composition the
 * card performs: changed lines for the inline view, ±3 context for the modal.
 */
const { contextWindow } = await import("../DiffCard");
const { unifiedDiff } = await import("../../../lib/diff");

describe("DiffCard — contextWindow", () => {
  it("keeps only ±3 context lines around each change, preserving order", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const after = [...before];
    after[10] = "CHANGED";
    const diff = unifiedDiff(before.join("\n"), after.join("\n"));
    const windowed = contextWindow(diff, 3);
    const texts = windowed.map((l) => l.text);
    expect(texts).toEqual([
      "line-7",
      "line-8",
      "line-9",
      "line-10",
      "CHANGED",
      "line-11",
      "line-12",
      "line-13",
    ]);
    // The change itself is kept as its del + add pair with gutter numbers.
    expect(windowed[3]).toMatchObject({
      kind: "del",
      text: "line-10",
      beforeLine: 11,
      afterLine: -1,
    });
    expect(windowed[4]).toMatchObject({
      kind: "add",
      text: "CHANGED",
      beforeLine: -1,
      afterLine: 11,
    });
  });

  it("ctx=0 keeps only the changed lines (the inline card's view)", () => {
    const diff = unifiedDiff("a\nb\nc\nd", "a\nB\nc\nd");
    const changed = contextWindow(diff, 0);
    expect(changed.map((l) => l.kind)).toEqual(["del", "add"]);
    expect(changed.map((l) => l.text)).toEqual(["b", "B"]);
  });

  it("does not drop anything when every line is within the window", () => {
    const diff = unifiedDiff("a\nb", "a\nB");
    expect(contextWindow(diff, 3)).toHaveLength(diff.length);
  });

  it("a no-change diff windows to nothing (the card shows its noChanges row)", () => {
    const diff = unifiedDiff("same", "same");
    expect(diff.every((l) => l.kind === "ctx")).toBe(true);
    expect(contextWindow(diff, 3)).toEqual([]);
  });
});
