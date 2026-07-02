import { describe, it, expect } from "vitest";
import { wordCleanup, isWordHtml } from "../wordCleanup";

describe("isWordHtml", () => {
  it("detects mso-", () => {
    expect(isWordHtml('<p style="mso-list: l0">x</p>')).toBe(true);
  });
  it("detects ProgId", () => {
    expect(isWordHtml('<meta name="ProgId" content="Word.Document">')).toBe(true);
  });
  it("clean html is not word", () => {
    expect(isWordHtml("<p>hello <b>world</b></p>")).toBe(false);
  });
});

describe("wordCleanup", () => {
  it("passes through clean html unchanged", () => {
    const html = "<p>hello <b>world</b></p>";
    expect(wordCleanup(html)).toBe(html);
  });
  it("strips conditional comments", () => {
    const out = wordCleanup("<!--[if gte mso 9]><xml>x</xml><![endif]--><p>hi</p>");
    expect(out).not.toContain("xml:x");
    expect(out).toContain("<p>hi</p>");
  });
  it("removes Office namespace tags keeping text", () => {
    const out = wordCleanup("<p>a<o:p>b</o:p>c</p>");
    expect(out).toContain("abc");
    expect(out.toLowerCase()).not.toContain("<o:p>");
  });
  it("strips mso-* styles and Mso classes", () => {
    const out = wordCleanup('<p class="MsoNormal" style="mso-margin-top-alt: auto; color: red">x</p>');
    expect(out).not.toContain("mso-");
    expect(out).not.toContain("MsoNormal");
    expect(out).toContain("color: red");
  });
  it("normalizes smart quotes and nbsp", () => {
    const out = wordCleanup("<p>\u201chello\u201d \u2018x\u2019 a\u00a0b</p>");
    expect(out).toContain('"hello"');
    expect(out).toContain("'x'");
    expect(out).not.toContain("\u00a0");
  });
});
