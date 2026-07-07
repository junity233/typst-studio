import { describe, expect, it } from "vitest";
import type { CommandContribution } from "../../../extensions/registry";
import { filterAndSort, scoreCommand } from "../fuzzyMatch";

function cmd(
  id: string,
  title: string,
  category?: string,
): CommandContribution {
  return { id, title, category, handler: () => {} };
}

const CMDS: CommandContribution[] = [
  cmd("save", "Save", "File"),
  cmd("save-as", "Save As", "File"),
  cmd("toggle-sidebar", "Toggle Sidebar", "View"),
  cmd("open-settings", "Open Settings", "View"),
  cmd("export-pdf", "Export PDF"),
];

describe("scoreCommand", () => {
  it("returns 0 (no match) when the query is not a subsequence", () => {
    expect(scoreCommand("xyz", CMDS[0])).toBe(0);
  });

  it("is case-insensitive", () => {
    const lower = scoreCommand("save", CMDS[0]);
    const upper = scoreCommand("SAVE", CMDS[0]);
    const mixed = scoreCommand("SaVe", CMDS[0]);
    expect(lower).toBeGreaterThan(0);
    expect(upper).toBe(lower);
    expect(mixed).toBe(lower);
  });

  it("scores a prefix match higher than a mid-word subsequence match", () => {
    // "save" is a prefix of "Save" but only a mid-word subsequence of "Save As".
    const prefixScore = scoreCommand("save", cmd("save", "Save"));
    const midScore = scoreCommand("save", cmd("save-as", "Save As"));
    expect(prefixScore).toBeGreaterThan(midScore);
  });

  it("scores a contiguous match higher than a gappy subsequence", () => {
    // "save" contiguous in "Save" vs "sae" gappy in "Save" (s-a-_-e).
    const contiguous = scoreCommand("save", cmd("save", "Save"));
    const gappy = scoreCommand("sae", cmd("save", "Save"));
    expect(contiguous).toBeGreaterThan(gappy);
  });

  it("participates the category as a fallback match", () => {
    // "file" matches only the category of "Save" — should still be a match.
    const categoryMatch = scoreCommand("file", cmd("save", "Save", "File"));
    expect(categoryMatch).toBeGreaterThan(0);
  });

  it("prefers a title match over a category match", () => {
    const c = cmd("save", "File", "View");
    // "file" matches the title exactly; "view" matches the category exactly.
    // The title match should win when scored.
    const titleScore = scoreCommand("file", c);
    const categoryScore = scoreCommand("view", c);
    expect(titleScore).toBeGreaterThan(categoryScore);
  });

  it("returns 0 for an empty query (matches-all is filterAndSort's job)", () => {
    expect(scoreCommand("", CMDS[0])).toBe(0);
  });
});

describe("filterAndSort", () => {
  it("returns all commands unchanged for an empty query", () => {
    expect(filterAndSort("", CMDS)).toEqual(CMDS);
  });

  it("returns all commands unchanged for a whitespace-only query", () => {
    expect(filterAndSort("   ", CMDS)).toEqual(CMDS);
  });

  it("excludes commands that do not match", () => {
    const result = filterAndSort("zzz", CMDS);
    expect(result).toEqual([]);
  });

  it("keeps only matching commands and sorts best-match-first", () => {
    const result = filterAndSort("save", CMDS);
    const ids = result.map((c) => c.id);
    // "Save" (prefix) should outrank "Save As" (mid-word); Export PDF excluded.
    expect(ids).toEqual(["save", "save-as"]);
  });

  it("breaks score ties by shorter title first, then alphabetically", () => {
    // Two pairs. Pair 1 has equal-length titles ("Open AAA"/"Open BBB") so they
    // genuinely tie on score and length — the alphabetical tiebreak decides.
    // Pair 2 ("Open" vs "Openness") has different lengths, so the shorter title
    // wins outright regardless of input order.
    const cmds = [
      cmd("bbb", "Open BBB", "View"),
      cmd("aaa", "Open AAA", "View"),
      cmd("long", "Openness", "View"),
      cmd("short", "Open", "View"),
    ];
    const result = filterAndSort("open", cmds);
    // "Open" (shortest) first, then the tied pair alphabetically (AAA before BBB).
    expect(result.map((c) => c.id)).toEqual(["short", "aaa", "bbb", "long"]);
  });

  it("matches via category too", () => {
    const result = filterAndSort("view", CMDS);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("toggle-sidebar");
    expect(ids).toContain("open-settings");
    expect(ids).not.toContain("save");
  });
});
