import { describe, expect, it } from "vitest";
import { countChars, countWords } from "../textStats";

describe("countWords", () => {
  it("counts Latin runs as single words", () => {
    expect(countWords("Hello world")).toBe(2);
    expect(countWords("one-word")).toBe(2);
    // "don't" splits at the apostrophe: don + t (+ stop) = 3.
    expect(countWords("don't stop")).toBe(3);
  });

  it("counts each CJK character as one word", () => {
    expect(countWords("中文")).toBe(2);
    expect(countWords("引言")).toBe(2);
  });

  it("mixes scripts and ignores punctuation/markup", () => {
    expect(countWords("= Introduction 引言")).toBe(3);
    expect(countWords("Hello，世界！")).toBe(3);
    expect(countWords("#set page(width: 10cm)")).toBe(4); // set, page, width, 10cm
  });

  it("handles empty and whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("counts kana as CJK", () => {
    expect(countWords("かな カナ")).toBe(4);
  });

  it("counts non-Latin alphabetic scripts as word runs", () => {
    expect(countWords("привет мир")).toBe(2);
    expect(countWords("Ελληνικά")).toBe(1);
    expect(countWords("مرحبا")).toBe(1);
  });

  it("symbols do not glue words together", () => {
    expect(countWords("3×4")).toBe(2);
    expect(countWords("a·b")).toBe(2);
  });
});

describe("countChars", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(countChars("a中")).toBe(2);
    // Astral plane char (𝕏 = 2 UTF-16 units) counts once.
    expect(countChars("𝕏")).toBe(1);
  });

  it("counts newlines and spaces as characters", () => {
    expect(countChars("a b\nc")).toBe(5);
  });

  it("empty text is zero", () => {
    expect(countChars("")).toBe(0);
  });
});
