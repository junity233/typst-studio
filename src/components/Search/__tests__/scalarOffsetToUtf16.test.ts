import { describe, it, expect } from "vitest";
import { scalarOffsetToUtf16 } from "../SearchPanel";

/**
 * `scalarOffsetToUtf16` is the single conversion point between the backend's
 * Rust `chars().count()` scalar offsets (see SearchHit in src/lib/types.ts and
 * src-tauri/src/fs/search.rs) and the frontend's UTF-16 code-unit world (JS
 * `String.slice`, Monaco columns). It feeds both the `<mark>` highlight slices
 * in `renderHitText` and the jump-to-hit caret column in `handleHitClick`
 * (`scalarOffsetToUtf16(line, column - 1) + 1`).
 *
 * These tests pin the conversion for the astral-plane cases (emoji = 1 scalar
 * but 2 UTF-16 units) that are common in CJK-heavy Typst documents, plus the
 * clamp-at-line-end and the 1-based column composition — the places where a
 * "simplification" would only surface as subtly mis-placed highlights/carets.
 */

describe("scalarOffsetToUtf16", () => {
  it("is the identity for pure-ASCII lines", () => {
    expect(scalarOffsetToUtf16("abcdef", 3)).toBe(3);
  });

  it("is the identity for BMP CJK lines (1 code unit per char)", () => {
    expect(scalarOffsetToUtf16("中文测试", 2)).toBe(2);
  });

  it("counts an astral char before the offset as 2 UTF-16 units", () => {
    // "a😀b": offset 2 sits after 'a'+😀 → 1 + 2 = 3 units.
    expect(scalarOffsetToUtf16("a😀b", 2)).toBe(3);
    // "😀ab": offset 1 sits right after the emoji → 2 units.
    expect(scalarOffsetToUtf16("😀ab", 1)).toBe(2);
  });

  it("accumulates across consecutive astral chars", () => {
    expect(scalarOffsetToUtf16("😀😀x", 3)).toBe(5);
  });

  it("handles mixed CJK + emoji hit lines", () => {
    // "标题😀内容": after 标题😀 (1+1+2) and after 内容's first char.
    expect(scalarOffsetToUtf16("标题😀内容", 3)).toBe(4);
    expect(scalarOffsetToUtf16("标题😀内容", 4)).toBe(5);
  });

  it("clamps to the line boundaries", () => {
    expect(scalarOffsetToUtf16("abc", 0)).toBe(0);
    expect(scalarOffsetToUtf16("abc", 10)).toBe(3);
    expect(scalarOffsetToUtf16("a😀b", 99)).toBe(4);
  });

  it("composes with the 1-based scalar column as used by handleHitClick", () => {
    // "a😀bc": backend 1-based scalar column 3 is 'b'. The jump target is
    // scalarOffsetToUtf16(line, column - 1) + 1 — i.e. Monaco's 1-based UTF-16
    // column for 'b', which sits after 'a' + the surrogate pair → column 4.
    expect(scalarOffsetToUtf16("a😀bc", 3 - 1) + 1).toBe(4);
  });
});
