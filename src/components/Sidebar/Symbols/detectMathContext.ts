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
 *  - `$` characters inside raw blocks (fenced ``` blocks and inline `...`
 *    spans) and comments (line comments and block comments) do NOT toggle the
 *    context — a stray `$` in a code sample must not flip math parity for the
 *    rest of the document. Block comments nest (Typst), so their depth is
 *    tracked. Fenced raws and block comments may span lines; inline raw
 *    (1-2 backticks) cannot, so an unterminated one is closed at the line
 *    end instead of poisoning all following lines.
 *  - A `//` that belongs to a URL scheme (`https://…`, which Typst auto-links)
 *    does NOT start a line comment.
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
  // Raw/comment state spans lines (fenced raw blocks and block comments can
  // cover multiple lines), so it lives outside the line loop.
  let blockCommentDepth = 0;
  let inRawFence = false;
  let inInlineRaw = false;

  for (let lineIndex = 0; lineIndex <= targetLineIndex; lineIndex++) {
    const text = lines[lineIndex];
    // On the cursor's line, only scan the characters that precede the cursor.
    const limit =
      lineIndex === targetLineIndex
        ? Math.min(cursorColExclusive, text.length)
        : text.length;
    let i = 0;
    while (i < limit) {
      const ch = text[i];
      if (blockCommentDepth > 0) {
        // Typst block comments nest: /* /* */ */ needs a depth counter.
        if (ch === "/" && text[i + 1] === "*") {
          blockCommentDepth++;
          i += 2;
        } else if (ch === "*" && text[i + 1] === "/") {
          blockCommentDepth--;
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (inRawFence || inInlineRaw) {
        // Only a backtick run can close a raw span; everything else is raw
        // content (any `$` inside is inert).
        if (ch === "`") {
          let run = 1;
          while (i + run < text.length && text[i + run] === "`") run++;
          if (inRawFence ? run >= 3 : true) {
            inRawFence = false;
            inInlineRaw = false;
          }
          i += run;
        } else {
          i++;
        }
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") {
        // Typst auto-links bare URLs, and the `//` of a scheme (`https://…`)
        // does NOT start a line comment — otherwise every `$` after the URL
        // would be skipped and math parity would break for the rest of the
        // document. If the token back to the previous whitespace/line start
        // is a `scheme:`, treat the `//` as ordinary content and keep
        // scanning (we do not try to find the URL's end).
        if (isSchemeSlashSlash(text, i)) {
          i += 2;
          continue;
        }
        break; // line comment: rest of line
      }
      if (ch === "/" && text[i + 1] === "*") {
        blockCommentDepth = 1;
        i += 2;
        continue;
      }
      if (ch === "`") {
        // A run of 3+ backticks opens a fenced raw block; 1-2 opens an inline
        // raw span.
        let run = 1;
        while (i + run < text.length && text[i + run] === "`") run++;
        if (run >= 3) {
          inRawFence = true;
        } else {
          inInlineRaw = true;
        }
        i += run;
        continue;
      }
      if (ch === "$") {
        // A `$` preceded by an unescaped backslash is an escaped dollar and
        // must not toggle math. A backslash itself is escaped by a preceding
        // backslash (`\\$` is a literal backslash then a real `$`), so count
        // the contiguous backslashes immediately before the `$`.
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && text.charCodeAt(j) === 0x5c /* '\\' */; j--) {
          backslashes++;
        }
        // An even run of backslashes means none of them escape the `$` (they
        // pair up into literal backslashes); an odd run means the `$` is
        // escaped.
        if (backslashes % 2 === 0) dollarCount++;
      }
      i++;
    }
    // Typst raw spans of 1-2 backticks cannot contain line breaks, so an
    // unterminated one must not leak its state into the next line (an
    // unmatched `` ` `` earlier in the document would otherwise poison math
    // detection for every following line). Fenced raws and block comments DO
    // span lines, so only their state is carried across.
    inInlineRaw = false;
  }

  return dollarCount % 2 === 1 ? "math" : "markup";
}

/**
 * True when the `//` at `index` belongs to a URL scheme (e.g. the `//` in
 * `https://example.com`): the token from the previous whitespace (or the line
 * start) up to `index` matches `scheme:` — a letter followed by letters,
 * digits, `+`, `.`, or `-`, ending with `:`.
 */
function isSchemeSlashSlash(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return /^[A-Za-z][A-Za-z0-9+.-]*:$/.test(text.slice(start, index));
}
