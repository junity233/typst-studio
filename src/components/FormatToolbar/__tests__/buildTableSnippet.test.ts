import { describe, it, expect } from "vitest";
import { buildTableSnippet } from "../buildTableSnippet";

/**
 * Format Toolbar Task 5 — `buildTableSnippet` pure helper tests.
 *
 * The snippet shape is pinned here so a typo is caught by the unit test rather
 * than discovered in the UI. The output must match the paste converter
 * (`src/lib/htmlToTypst/tables.ts`): `columns: N`, `[ ]` cells (single space
 * so the cell renders with non-zero height), one row per line, trailing comma
 * after the final row (Typst permits it).
 */
describe("buildTableSnippet", () => {
  it("1×1 → columns: 1, single [ ] cell, trailing comma", () => {
    expect(buildTableSnippet(1, 1)).toBe(
      "#table(\n  columns: 1,\n  [ ],\n)",
    );
  });

  it("2 cols × 3 rows → matches the spec example exactly", () => {
    expect(buildTableSnippet(3, 2)).toBe(
      [
        "#table(",
        "  columns: 2,",
        "  [ ], [ ],",
        "  [ ], [ ],",
        "  [ ], [ ],",
        ")",
      ].join("\n"),
    );
  });

  it("3 cols × 2 rows → columns: 3, two rows of three cells", () => {
    expect(buildTableSnippet(2, 3)).toBe(
      [
        "#table(",
        "  columns: 3,",
        "  [ ], [ ], [ ],",
        "  [ ], [ ], [ ],",
        ")",
      ].join("\n"),
    );
  });

  it("columns: N always matches the cols argument", () => {
    for (const cols of [1, 2, 4, 8]) {
      const out = buildTableSnippet(2, cols);
      expect(out).toContain(`columns: ${cols},`);
    }
  });

  it("every cell is `[ ]` (single space content)", () => {
    // Count [ ] occurrences == rows * cols for a 4×5 table.
    const out = buildTableSnippet(4, 5);
    const count = (out.match(/\[ \]/g) ?? []).length;
    expect(count).toBe(20);
    // No empty cells leak in.
    expect(out).not.toContain("[]");
  });

  it("each row's cells on one line, rows separated by ,\\n", () => {
    const out = buildTableSnippet(2, 2);
    // Row lines (after the columns line) are "  [ ], [ ],"
    const lines = out.split("\n");
    expect(lines[2]).toBe("  [ ], [ ],");
    expect(lines[3]).toBe("  [ ], [ ],");
  });

  it("trailing comma present after the final row", () => {
    expect(buildTableSnippet(1, 1)).toMatch(/,\n\)$/);
    expect(buildTableSnippet(3, 2)).toMatch(/,\n\)$/);
  });

  it("does not crash on degenerate 0×N / N×0 inputs (sane output)", () => {
    // rows=0 → no row lines, but still a valid (degenerate) #table().
    expect(buildTableSnippet(0, 2)).toBe("#table(\n  columns: 2,\n)");
    expect(buildTableSnippet(2, 0)).toBe("#table(\n  columns: 0,\n)");
    expect(buildTableSnippet(0, 0)).toBe("#table(\n  columns: 0,\n)");
  });
});
