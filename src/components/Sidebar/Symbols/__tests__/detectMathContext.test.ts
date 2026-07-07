import { describe, expect, it } from "vitest";
import { detectMathContext } from "../detectMathContext";

describe("detectMathContext", () => {
  it("returns markup for plain markup with no `$`", () => {
    const lines = ["Hello world", "Some text here"];
    expect(detectMathContext(lines, 2, 5)).toBe("markup");
  });

  it("returns markup for an empty document", () => {
    expect(detectMathContext([], 1, 1)).toBe("markup");
    expect(detectMathContext([""], 1, 1)).toBe("markup");
  });

  it("returns markup at the very start of the document", () => {
    expect(detectMathContext(["$x$"], 1, 1)).toBe("markup");
  });

  it("detects inline math when the cursor is inside `$...$`", () => {
    // "foo $x$ bar" — positions (1-indexed column):
    //   f(1) o(2) o(3) space(4) $(5) x(6) $(7) ...
    // Cursor at column 6 (the `x`) sits between two `$` → inside math.
    expect(detectMathContext(["foo $x$ bar"], 1, 6)).toBe("math");
    // Cursor at column 7 is *on* the closing `$`: that `$` is not counted, so
    // we've seen only the opening `$` (1, odd) → still math.
    expect(detectMathContext(["foo $x$ bar"], 1, 7)).toBe("math");
  });

  it("returns markup after the closing `$`", () => {
    // Cursor at column 8 (just past the closing `$`) → 2 `$` seen (even).
    expect(detectMathContext(["foo $x$ bar"], 1, 8)).toBe("markup");
  });

  it("treats a `$` immediately before the cursor as not-yet-opened", () => {
    // "foo $bar" — the `$` is at index 4 (column 5). Cursor at column 5 sits
    // ON the `$`; we don't count it, so 0 seen → markup (region not entered).
    expect(detectMathContext(["foo $bar"], 1, 5)).toBe("markup");
    // One past the `$` → 1 seen (odd) → math.
    expect(detectMathContext(["foo $bar"], 1, 6)).toBe("math");
  });

  it("detects multi-line math blocks", () => {
    // Line 2 opens math with `$`, line 4 closes it with `$`. Cursor on line 3
    // is inside the open math region.
    const lines = ["intro", "$ a + b", "  = c", "$ done", "trailer"];
    expect(detectMathContext(lines, 3, 3)).toBe("math");
    // Cursor on line 4 *on* the closing `$` (column 1): that `$` is not counted,
    // only the opening `$` on line 2 was (1, odd) → still math.
    expect(detectMathContext(lines, 4, 1)).toBe("math");
    // Cursor on line 4 one past the closing `$` (column 2): both `$` counted
    // (2, even) → markup.
    expect(detectMathContext(lines, 4, 2)).toBe("markup");
    // Cursor on line 5 → markup.
    expect(detectMathContext(lines, 5, 3)).toBe("markup");
  });

  it("does not toggle context on an escaped `\\$`", () => {
    // "a \\$ b $ c" — the `\$` is escaped (doesn't count); the lone `$` is the
    // only real toggle. Cursor past the lone `$` → math.
    // Indices: a(0) space(1) \\(2) $(3) space(4) b(5) space(6) $(7) space(8) c(9)
    // The escaped `$` is at index 3; the real `$` is at index 7.
    expect(detectMathContext(["a \\$ b $ c"], 1, 10)).toBe("math");
    // Cursor before the real `$` (column 7, i.e. index 6) → only the escaped
    // `$` seen (0 real) → markup.
    expect(detectMathContext(["a \\$ b $ c"], 1, 7)).toBe("markup");
  });

  it("treats a doubled backslash before `$` as a literal backslash + real `$`", () => {
    // "\\\\$" is a literal backslash followed by a real `$` (the two backslashes
    // pair up, so the `$` is NOT escaped). Cursor one past that `$` → math.
    expect(detectMathContext(["\\\\$"], 1, 4)).toBe("math");
  });

  it("handles multiple inline math regions on one line", () => {
    // "$a$ + $b$" — two balanced regions. After the final `$` everything is
    // closed (3 `$`? no: 4 `$` total → even → markup).
    expect(detectMathContext(["$a$ + $b$"], 1, 10)).toBe("markup");
    // Cursor inside the second region (the `b`, column 8) → 3 `$` seen → math.
    expect(detectMathContext(["$a$ + $b$"], 1, 8)).toBe("math");
  });

  it("clamps out-of-range cursor positions to markup without throwing", () => {
    expect(detectMathContext(["x"], 5, 1)).toBe("markup");
    expect(detectMathContext(["x"], 0, 1)).toBe("markup");
  });
});
