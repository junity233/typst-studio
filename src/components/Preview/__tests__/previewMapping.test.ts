import { describe, expect, it } from "vitest";
import {
  constrainSynchronizedScrollTarget,
  lineRectBounds,
  rectsForLine,
} from "../previewMapping";
import type { LineRect } from "../../../lib/types";

describe("rectsForLine", () => {
  it("returns every fragment for the requested source line in input order", () => {
    const rects: LineRect[] = [
      { line: 10, page: 0, x: 24, y: 80, w: 90, h: 12 },
      { line: 11, page: 0, x: 24, y: 96, w: 120, h: 12 },
      { line: 10, page: 0, x: 24, y: 112, w: 75, h: 12 },
    ];

    expect(rectsForLine(rects, 10)).toEqual([rects[0], rects[2]]);
  });

  it("returns an empty array when the line has no preview fragments", () => {
    const rects: LineRect[] = [
      { line: 3, page: 0, x: 10, y: 10, w: 50, h: 12 },
    ];

    expect(rectsForLine(rects, 99)).toEqual([]);
  });
});

describe("lineRectBounds", () => {
  it("returns the union box for multiple fragments of the same line", () => {
    const rects: LineRect[] = [
      { line: 10, page: 0, x: 24, y: 80, w: 90, h: 12 },
      { line: 10, page: 0, x: 18, y: 110, w: 120, h: 14 },
      { line: 10, page: 0, x: 60, y: 96, w: 30, h: 10 },
    ];

    expect(lineRectBounds(rects)).toEqual({
      x: 18,
      y: 80,
      w: 120,
      h: 44,
    });
  });

  it("returns null for an empty fragment set", () => {
    expect(lineRectBounds([])).toBeNull();
  });
});

describe("constrainSynchronizedScrollTarget", () => {
  it("pins the follower to zero when the driver is at the top", () => {
    expect(constrainSynchronizedScrollTarget(0, 500, 800, 48)).toBe(0);
    expect(constrainSynchronizedScrollTarget(0.25, 500, 800, null)).toBe(0);
  });

  it("pins the follower to its own bottom when the driver reaches bottom", () => {
    expect(constrainSynchronizedScrollTarget(500, 500, 800, 600)).toBe(800);
    expect(constrainSynchronizedScrollTarget(499.75, 500, 800, null)).toBe(800);
  });

  it("bounds content-based mapping to the follower's scroll range", () => {
    expect(constrainSynchronizedScrollTarget(100, 500, 800, 48)).toBe(48);
    expect(constrainSynchronizedScrollTarget(100, 500, 800, -20)).toBe(0);
    expect(constrainSynchronizedScrollTarget(100, 500, 800, 900)).toBe(800);
    expect(constrainSynchronizedScrollTarget(100, 500, 800, null)).toBeNull();
  });
});
