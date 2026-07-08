import { describe, it, expect } from "vitest";
import { buildTypstMathInsert, type FormulaMode } from "../insertTypstMath";

/**
 * Pure-function tests for the Typst-math wrapping rule.
 *
 * `buildTypstMathInsert` decides how to wrap the tylax-converted Typst math
 * body based on (a) the cursor's math context and (b) the user's inline/display
 * choice. These are the exact strings that land in the editor buffer, so each
 * case is pinned precisely — a stray space or a missing `$` would be a real
 * Typst syntax error.
 *
 * Typst math-mode rule being honored:
 *  - `$x$`   (no inner space) → INLINE math
 *  - `$ x $` (inner spaces)   → DISPLAY math block (centered, own line)
 *  - already inside `$…$`     → insert the body bare (no re-wrapping)
 */

describe("buildTypstMathInsert", () => {
  it("in math context: inserts the body verbatim regardless of mode", () => {
    // The cursor sits inside an existing `$…$`, so wrapping again would
    // produce `$…$ a/b $…$` (syntax error). Both modes must drop the body bare.
    expect(buildTypstMathInsert("math", "inline", "a/b")).toBe("a/b");
    expect(buildTypstMathInsert("math", "display", "frac(a, b)")).toBe(
      "frac(a, b)",
    );
  });

  it("in markup + inline: wraps as tight `$…$` (no inner space)", () => {
    expect(buildTypstMathInsert("markup", "inline", "a/b")).toBe("$a/b$");
    // A more complex converted body round-trips untouched inside the `$…$`.
    expect(buildTypstMathInsert("markup", "inline", "sum_(i=1)^n x_i")).toBe(
      "$sum_(i=1)^n x_i$",
    );
  });

  it("in markup + display: wraps as spaced `$ … $` (display block)", () => {
    // The inner spaces are what make Typst treat this as a centered display
    // block (vs. inline). Pinned exactly.
    expect(buildTypstMathInsert("markup", "display", "a/b")).toBe("$ a/b $");
    expect(buildTypstMathInsert("markup", "display", "frac(a, b)")).toBe(
      "$ frac(a, b) $",
    );
  });

  it("preserves the body exactly (no trimming or escaping)", () => {
    // Leading/trailing spaces in the converted body are the converter's
    // responsibility; we only add the `$` wrappers. Round-trip the body.
    const body = "  x + 1  ";
    expect(buildTypstMathInsert("markup", "inline", body)).toBe(`$${body}$`);
  });

  it("handles an empty body (degenerate but must not throw)", () => {
    // An empty conversion shouldn't happen in practice (the modal gates on
    // non-empty input), but the helper must be total — it applies the same
    // wrapping rule to whatever body it gets.
    expect(buildTypstMathInsert("markup", "inline", "")).toBe("$$");
    expect(buildTypstMathInsert("markup", "display", "")).toBe("$  $");
    expect(buildTypstMathInsert("math", "inline", "")).toBe("");
  });

  it("FormulaMode type is the expected union (compile-time guard)", () => {
    // Trivial runtime assertion; the real value is that this line type-checks
    // only if FormulaMode is "inline" | "display".
    const m: FormulaMode = "inline";
    expect(["inline", "display"]).toContain(m);
  });
});
