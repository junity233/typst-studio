/**
 * Context-aware symbol insertion: a symbol dropped into a Typst math region
 * (`$...$`) must be inserted by its bare name (e.g. `alpha`), while the same
 * symbol inserted into markup must be prefixed with the `sym` module
 * (e.g. `#sym.alpha`). This module decides which of those two contexts the
 * cursor is in — purely, from the document lines + cursor position, with no
 * dependency on Monaco or React so it can be unit-tested in isolation.
 */

export type MathContext = "math" | "markup";

/**
 * Decide whether the cursor at `(lineNumber, column)` [1-based, Monaco
 * convention] sits inside Typst math mode (`$...$`).
 *
 * Strategy: scan backward from the start of the document over the model lines,
 * counting unescaped, unpaired `$` characters. An odd count means we're inside
 * a math region. Concretely we walk line 1 → the cursor's line; for every line
 * *before* the cursor's line we count every unescaped `$`, and on the cursor's
 * line we only count `$` characters that precede the cursor (indices `< column
 * - 1`). If the running count is odd the cursor is in math mode, else markup.
 *
 * Edge cases handled:
 *  - `\$` is an escaped dollar and does NOT toggle the context.
 *  - A `$` the cursor sits *on* (its index is `column - 1`) is NOT counted: the
 *    region it would open hasn't been entered yet (and the region it would close
 *    is, by the same token, still "behind" the cursor for insertion purposes).
 *  - Multi-line math blocks (a `$` opens math on one line and closes it on a
 *    later line) are handled naturally because the scan spans whole lines.
 *  - An empty document, or a cursor at (1, 1), yields `"markup"` (zero `$`
 *    seen → even).
 *
 * Pure: takes the full document lines + cursor position, returns the context.
 */
export function detectMathContext(
  lines: string[],
  lineNumber: number,
  column: number,
): MathContext {
  // Clamp to valid bounds so out-of-range values degrade to "markup" rather
  // than throwing — the caller (a click handler) must never crash the panel.
  if (lines.length === 0 || lineNumber < 1) return "markup";
  const targetLineIndex = Math.min(lineNumber, lines.length) - 1;
  // column is 1-based; characters strictly before the cursor are indices
  // [0, column - 1). We never count the `$` the cursor is *on*.
  const cursorColExclusive = Math.max(0, column - 1);

  let dollarCount = 0;
  for (let lineIndex = 0; lineIndex <= targetLineIndex; lineIndex++) {
    const text = lines[lineIndex];
    // On the cursor's line, only scan the characters that precede the cursor.
    const limit =
      lineIndex === targetLineIndex
        ? Math.min(cursorColExclusive, text.length)
        : text.length;
    // Walk the run of characters; a `$` preceded by an unescaped backslash is
    // an escaped dollar and must not toggle math. A backslash itself is escaped
    // by a preceding backslash (`\\$` is a literal backslash then a real `$`),
    // so we count the contiguous backslashes immediately before each `$`.
    for (let i = 0; i < limit; i++) {
      if (text.charCodeAt(i) !== 0x24 /* '$' */) continue;
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && text.charCodeAt(j) === 0x5c /* '\\' */; j--) {
        backslashes++;
      }
      // An even run of backslashes means none of them escape the `$` (they pair
      // up into literal backslashes); an odd run means the `$` is escaped.
      if (backslashes % 2 === 0) dollarCount++;
    }
  }

  return dollarCount % 2 === 1 ? "math" : "markup";
}
