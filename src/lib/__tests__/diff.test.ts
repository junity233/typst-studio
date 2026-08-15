import { describe, it, expect } from "vitest";
import { sideBySideDiff, wordDiff, hasChanges, unifiedDiff } from "../diff";

/**
 * Pure-diff acceptance tests for the conflict/recovery compare views
 * (§5.1.3 / §5.4). The behaviors that matter for the dialogs:
 *
 *   - every change is found, including MULTIPLE separated changes (the
 *     prefix/suffix-only heuristic used elsewhere cannot do this);
 *   - paired changed lines get word-level emphasis on each side;
 *   - long unchanged runs collapse to gap rows (with context kept);
 *   - pathological inputs degrade to a coarse diff instead of exploding.
 */

/** Non-equal rows as a compact string, e.g. "pair", "del", "add". */
function changeKinds(rows: ReturnType<typeof sideBySideDiff>): string[] {
  return rows.filter((r) => r.kind !== "equal" && r.kind !== "gap").map((r) => r.kind);
}

/** Plain text of each row (pair rows render left|right joined for comparison). */
function rowTexts(rows: ReturnType<typeof sideBySideDiff>): string[] {
  return rows.map((r) => {
    switch (r.kind) {
      case "equal":
      case "del":
      case "add":
        return r.text;
      case "gap":
        return `⟨gap ${r.count}⟩`;
      case "pair":
        return `${r.left.map((s) => s.text).join("")}|${r.right.map((s) => s.text).join("")}`;
    }
  });
}

describe("sideBySideDiff — change detection", () => {
  it("returns only equal rows for identical texts (no gap, no changes)", () => {
    const rows = sideBySideDiff("a\nb\nc", "a\nb\nc");
    expect(changeKinds(rows)).toEqual([]);
    expect(hasChanges(rows)).toBe(false);
    expect(rowTexts(rows)).toEqual(["a", "b", "c"]);
  });

  it("handles identical empty strings (zero lines — no phantom empty row)", () => {
    const rows = sideBySideDiff("", "");
    expect(rows).toEqual([]);
    expect(hasChanges(rows)).toBe(false);
  });

  it("finds two separated changes (the prefix/suffix heuristic's blind spot)", () => {
    const left = ["l1", "same", "mid", "same2", "l5"].join("\n");
    const right = ["L1", "same", "MID", "same2", "l5"].join("\n");
    const rows = sideBySideDiff(left, right);
    const kinds = changeKinds(rows);
    // Both edits surface as their own pair row, not one merged block.
    expect(kinds.filter((k) => k === "pair")).toHaveLength(2);
    expect(hasChanges(rows)).toBe(true);
    // Untouched lines remain as context around each change. A pair row
    // renders as "left|right".
    expect(rowTexts(rows)).toEqual(["l1|L1", "same", "mid|MID", "same2", "l5"]);
  });

  it("pure addition: every added line is an add row", () => {
    const rows = sideBySideDiff("a\nc", "a\nb\nc");
    expect(changeKinds(rows)).toEqual(["add"]);
    expect(rows[1]).toEqual({ kind: "add", text: "b" });
  });

  it("pure deletion: every deleted line is a del row", () => {
    const rows = sideBySideDiff("a\nb\nc", "a\nc");
    expect(changeKinds(rows)).toEqual(["del"]);
    expect(rows[1]).toEqual({ kind: "del", text: "b" });
  });

  it("empty vs content is a pure addition (no phantom empty deletion)", () => {
    const rows = sideBySideDiff("", "new line");
    expect(changeKinds(rows)).toEqual(["add"]);
    expect(rows[0]).toEqual({ kind: "add", text: "new line" });
  });

  it("a trailing-newline difference is a real (if small) change", () => {
    const rows = sideBySideDiff("a\nb", "a\nb\n");
    expect(hasChanges(rows)).toBe(true);
  });
});

describe("sideBySideDiff — gap collapsing", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => `line${i}`);

  it("collapses a long unchanged middle into a gap row with 3-line context", () => {
    const lines = mk(20);
    const left = [...lines, "tail-left"].join("\n");
    const right = [...lines, "tail-right"].join("\n");
    const rows = sideBySideDiff(left, right);
    const gap = rows.find((r) => r.kind === "gap");
    // 20 equal lines: 3 kept at the head, gap of 17−3 = 14... but the change
    // is at the END, so the whole leading run keeps only its TAIL 3 lines:
    // gap count = 20 − 3 = 17.
    expect(gap).toEqual({ kind: "gap", count: 17 });
    // Context directly above the change is kept (after the gap row).
    const texts = rowTexts(rows);
    expect(texts[0]).toBe("⟨gap 17⟩");
    expect(texts.slice(1, 4)).toEqual(["line17", "line18", "line19"]);
    expect(texts[texts.length - 1]).toBe("tail-left|tail-right");
  });

  it("keeps context on both sides of a change in the middle", () => {
    const lines = mk(20);
    lines[10] = "CHANGED";
    const rows = sideBySideDiff(lines.join("\n"), lines.join("\n") === "" ? "" : lines.join("\n"));
    // Identical texts → no changes at all (guard for the fixture below).
    expect(hasChanges(rows)).toBe(false);

    const rightLines = [...lines];
    rightLines[10] = "CHANGED-NEW";
    const rows2 = sideBySideDiff(lines.join("\n"), rightLines.join("\n"));
    const texts = rowTexts(rows2);
    // gap(7) + line7..line9 + pair + line11..line13 + gap(6)
    expect(texts[0]).toBe("⟨gap 7⟩");
    expect(texts.slice(1, 4)).toEqual(["line7", "line8", "line9"]);
    expect(texts[4]).toBe("CHANGED|CHANGED-NEW");
    expect(texts.slice(5, 8)).toEqual(["line11", "line12", "line13"]);
    expect(texts[8]).toBe("⟨gap 6⟩");
  });

  it("does not collapse short runs (≤ context*2 + minGap)", () => {
    const rows = sideBySideDiff("a\nb\nc\nd\ne\nX", "a\nb\nc\nd\ne\nY");
    expect(rows.some((r) => r.kind === "gap")).toBe(false);
  });
});

describe("sideBySideDiff — pairing and word emphasis", () => {
  it("pairs a replaced line and emphasizes only the differing word on each side", () => {
    const rows = sideBySideDiff("the quick brown fox", "the slow brown fox");
    const pair = rows.find((r) => r.kind === "pair");
    expect(pair).toBeDefined();
    if (pair?.kind !== "pair") return;
    const flat = (spans: typeof pair.left, emphasis: string) =>
      spans
        .filter((s) => s.emphasis === emphasis)
        .map((s) => s.text)
        .join("");
    expect(flat(pair.left, "del")).toBe("quick");
    expect(flat(pair.right, "add")).toBe("slow");
    // Reassembling the spans reproduces the original lines exactly.
    expect(pair.left.map((s) => s.text).join("")).toBe("the quick brown fox");
    expect(pair.right.map((s) => s.text).join("")).toBe("the slow brown fox");
  });

  it("an uneven del/add run pairs the shorter count and keeps leftovers standalone", () => {
    // 1 old line replaced by 2 new lines → 1 pair + 1 add.
    const rows = sideBySideDiff("old line", "new line\nextra");
    expect(changeKinds(rows).sort()).toEqual(["add", "pair"]);
  });

  it("never pairs identical lines (LCS consumed them as equals)", () => {
    // Reordering produces standalone del + add rows, not a bogus pair of
    // equal texts.
    const rows = sideBySideDiff("x\ny", "y\nx");
    const pairs = rows.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(0);
    expect(hasChanges(rows)).toBe(true);
  });
});

describe("sideBySideDiff — large-input fallback", () => {
  it("degrades to a coarse diff when the changed middle exceeds the LCS cap", () => {
    // Two completely different 3000-line sides: (3001)^2 > 4M cells → the
    // DP is skipped and the whole middle becomes one del+add block, i.e.
    // 3000 pair rows with whole-line emphasis (no word alignment).
    const left = Array.from({ length: 3000 }, (_, i) => `left-${i}`).join("\n");
    const right = Array.from({ length: 3000 }, (_, i) => `right-${i}`).join("\n");
    const rows = sideBySideDiff(left, right);
    expect(hasChanges(rows)).toBe(true);
    const pairs = rows.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(3000);
    // Every line is present on its side (no content dropped).
    expect(pairs[0]).toMatchObject({
      left: [{ text: "left-0", emphasis: "del" }],
      right: [{ text: "right-0", emphasis: "add" }],
    });
    expect(pairs[2999]).toMatchObject({
      left: [{ text: "left-2999", emphasis: "del" }],
      right: [{ text: "right-2999", emphasis: "add" }],
    });
  });

  it("a small edit inside a HUGE document stays precise (prefix/suffix trim)", () => {
    const n = 5000;
    const lines = Array.from({ length: n }, (_, i) => `line-${i}`);
    const left = lines.join("\n");
    const changed = [...lines];
    changed[2500] = "line-2500-EDITED";
    const rows = sideBySideDiff(left, changed.join("\n"));
    expect(changeKinds(rows)).toEqual(["pair"]);
  });
});

describe("unifiedDiff (single-column, used by the assistant DiffCard)", () => {
  it("all context for identical texts, with aligned line numbers", () => {
    const lines = unifiedDiff("a\nb\nc", "a\nb\nc");
    expect(lines).toEqual([
      { kind: "ctx", text: "a", beforeLine: 1, afterLine: 1 },
      { kind: "ctx", text: "b", beforeLine: 2, afterLine: 2 },
      { kind: "ctx", text: "c", beforeLine: 3, afterLine: 3 },
    ]);
  });

  it("two separated changes keep the untouched middle line as context", () => {
    // The motivating fix: the old first/last-differing-line heuristic marked
    // EVERYTHING between the two edits del+add — "keep" below would appear
    // as both a deletion and an addition.
    const before = "l1\nx1\nkeep\nx2\nl5".split("\n");
    const after = "l1\nX1\nkeep\nX2\nl5".split("\n");
    const lines = unifiedDiff(before.join("\n"), after.join("\n"));
    const keep = lines.find((l) => l.text === "keep");
    expect(keep).toEqual({
      kind: "ctx",
      text: "keep",
      beforeLine: 3,
      afterLine: 3,
    });
    // Exactly one del and one add per edited line.
    const dels = lines.filter((l) => l.kind === "del").map((l) => l.text);
    const adds = lines.filter((l) => l.kind === "add").map((l) => l.text);
    expect(dels).toEqual(["x1", "x2"]);
    expect(adds).toEqual(["X1", "X2"]);
  });

  it("pure addition: added lines have beforeLine -1 and shifted afterLine", () => {
    const lines = unifiedDiff("a\nc", "a\nb\nc");
    expect(lines).toEqual([
      { kind: "ctx", text: "a", beforeLine: 1, afterLine: 1 },
      { kind: "add", text: "b", beforeLine: -1, afterLine: 2 },
      { kind: "ctx", text: "c", beforeLine: 2, afterLine: 3 },
    ]);
  });

  it("pure deletion: deleted lines have afterLine -1", () => {
    const lines = unifiedDiff("a\nb\nc", "a\nc");
    expect(lines).toEqual([
      { kind: "ctx", text: "a", beforeLine: 1, afterLine: 1 },
      { kind: "del", text: "b", beforeLine: 2, afterLine: -1 },
      { kind: "ctx", text: "c", beforeLine: 3, afterLine: 2 },
    ]);
  });

  it("empty before yields a single addition; empty after a single deletion", () => {
    expect(unifiedDiff("", "hello")).toEqual([
      { kind: "add", text: "hello", beforeLine: -1, afterLine: 1 },
    ]);
    expect(unifiedDiff("hello", "")).toEqual([
      { kind: "del", text: "hello", beforeLine: 1, afterLine: -1 },
    ]);
  });
});

describe("wordDiff", () => {
  it("returns null above the token cap (absurdly long lines)", () => {
    const a = "x ".repeat(1000); // 2000 tokens
    const b = ("y " + a).repeat(1) + "z ".repeat(1000); // ~4002 tokens
    expect(wordDiff(a, b)).toBeNull();
  });

  it("empty vs non-empty line emphasizes the whole line on the right", () => {
    const wd = wordDiff("", "added");
    expect(wd).not.toBeNull();
    expect(wd!.left).toEqual([]);
    expect(wd!.right).toEqual([{ text: "added", emphasis: "add" }]);
  });

  it("whitespace-only change is visible as del/add emphasis", () => {
    const wd = wordDiff("a  b", "a b");
    expect(wd!.left.some((s) => s.emphasis === "del")).toBe(true);
    expect(wd!.right.some((s) => s.emphasis === "add")).toBe(true);
  });
});
