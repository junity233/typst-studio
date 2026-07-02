import { describe, it, expect } from "vitest";
import { escapeTypst, escapeTypstStr } from "../escape";

describe("escapeTypst", () => {
  it("escapes all special Typst chars", () => {
    expect(escapeTypst("a*b_c`d[e]f$g#h@i~j\\k")).toBe(
      "a\\*b\\_c\\`d\\[e\\]f\\$g\\#h\\@i\\~j\\\\k",
    );
  });
  it("leaves plain text alone", () => {
    expect(escapeTypst("Hello World 123")).toBe("Hello World 123");
  });
  it("escapes unicode-looking ascii only", () => {
    expect(escapeTypst("price = $5")).toBe("price = \\$5");
  });
});

describe("escapeTypstStr", () => {
  it("escapes embedded double quotes", () => {
    expect(escapeTypstStr('a"b')).toBe('a\\"b');
  });
  it("escapes backslashes (windows paths)", () => {
    expect(escapeTypstStr("a\\b")).toBe("a\\\\b");
  });
  it("leaves plain text alone", () => {
    expect(escapeTypstStr("plain")).toBe("plain");
  });
});
