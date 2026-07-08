import type { MathContext } from "../Sidebar/Symbols/detectMathContext";

/**
 * Math insertion mode chosen by the user in the Insert Formula modal:
 *  - `"inline"`  → a Typst inline math span `$ … $` (stays in the text flow)
 *  - `"display"` → a Typst display math block `$ … $` on its own line
 *                  (Typst distinguishes inline vs. display by the surrounding
 *                  whitespace: `$x$` is inline, `$ x $` is a centered block).
 */
export type FormulaMode = "inline" | "display";

/**
 * Build the text to insert into the editor for a converted Typst math body,
 * given the cursor's math context and the user's inline/display choice.
 *
 * Rules:
 *  - **Already in math mode** (`context === "math"`): insert the converted body
 *    VERBATIM, with no `$` wrapping. The cursor sits inside an existing
 *    `$…$` region, so wrapping again would produce `$…$ … $…$` (a syntax
 *    error). The inline/display choice is irrelevant here — the surrounding
 *    math region already decided the mode.
 *  - **In markup + inline**: wrap as `$…$` (no inner spaces → Typst inline).
 *  - **In markup + display**: wrap as `$ … $` (inner spaces → Typst display
 *    block). The body is NOT newline-padded; the caller's `replaceSelection`
 *    drops it at the cursor, and the surrounding `$ x $` already forms a valid
 *    block. We don't force newlines because the user may be mid-line.
 *
 * Pure: takes the context + mode + body, returns the exact string to insert.
 * Mirrors the testability discipline of `editorEdit.ts` /
 * `detectMathContext.ts` (pure logic, unit-tested in isolation).
 */
export function buildTypstMathInsert(
  context: MathContext,
  mode: FormulaMode,
  typstMath: string,
): string {
  if (context === "math") return typstMath;
  // markup
  return mode === "display" ? `$ ${typstMath} $` : `$${typstMath}$`;
}
