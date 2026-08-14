import { describe, expect, it } from "vitest";
import { clampActiveIndex, findMatchingLines, rectsByPageForLines } from "../previewSearch";
import type { LineRect } from "../../../lib/types";

const rect = (line: number, page: number): LineRect =>
  ({ line, page, x: 0, y: 10 * line, w: 100, h: 8 }) as LineRect;

describe("findMatchingLines", () => {
  it("finds case-insensitive substring matches as 0-based indices", () => {
    const lines = ["Introduction", "the METHOD section", "results", "methods again"];
    expect(findMatchingLines(lines, "method")).toEqual([1, 3]);
  });

  it("matches CJK queries", () => {
    expect(findMatchingLines(["= 引言", "= 方法"], "引言")).toEqual([0]);
  });

  it("empty or whitespace query matches nothing", () => {
    expect(findMatchingLines(["abc"], "")).toEqual([]);
    expect(findMatchingLines(["abc"], "   ")).toEqual([]);
  });

  it("no matches yields empty list", () => {
    expect(findMatchingLines(["abc"], "zzz")).toEqual([]);
  });
});

describe("rectsByPageForLines", () => {
  it("buckets 0-based line indices into per-page rect lists", () => {
    const lineMap = [rect(1, 0), rect(2, 0), rect(2, 1), rect(3, 1)];
    const buckets = rectsByPageForLines(lineMap, [0, 1]);
    expect(buckets.get(0)).toEqual([rect(1, 0), rect(2, 0)]);
    expect(buckets.get(1)).toEqual([rect(2, 1)]);
    expect(buckets.has(2)).toBe(false);
  });

  it("undefined lineMap yields no buckets", () => {
    expect(rectsByPageForLines(undefined, [0]).size).toBe(0);
  });
});

describe("clampActiveIndex", () => {
  it("wraps forward and backward", () => {
    expect(clampActiveIndex(3, 3)).toBe(0);
    expect(clampActiveIndex(-1, 3)).toBe(2);
  });

  it("is -1 with no matches and tolerates garbage input", () => {
    expect(clampActiveIndex(0, 0)).toBe(-1);
    expect(clampActiveIndex(NaN, 3)).toBe(0);
  });
});
