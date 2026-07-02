import { describe, it, expect } from "vitest";
import { convertInline } from "../inline";
import { makeWalkCtx } from "../types";

function walk(html: string) {
  const wctx = makeWalkCtx({ imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { typst: convertInline(doc.body, wctx), wctx };
}

describe("convertInline", () => {
  it("plain text is escaped", () => {
    expect(walk("a*b").typst).toBe("a\\*b");
  });
  it("bold and strong -> *..*", () => {
    expect(walk("<b>hi</b>").typst).toBe("*hi*");
    expect(walk("<strong>hi</strong>").typst).toBe("*hi*");
  });
  it("italic and em -> _.._", () => {
    expect(walk("<i>hi</i>").typst).toBe("_hi_");
    expect(walk("<em>hi</em>").typst).toBe("_hi_");
  });
  it("nested b+i", () => {
    expect(walk("<b><i>x</i></b>").typst).toBe("*_x_*");
  });
  it("code -> backticks", () => {
    expect(walk("<code>x*y</code>").typst).toBe("`x*y`");
  });
  it("del -> strike", () => {
    expect(walk("<del>x</del>").typst).toBe("#strike[x]");
  });
  it("u -> underline", () => {
    expect(walk("<u>x</u>").typst).toBe("#underline[x]");
  });
  it("sub/sup", () => {
    expect(walk("<sub>2</sub>").typst).toBe("#sub 2");
    expect(walk("<sup>2</sup>").typst).toBe("#super 2");
  });
  it("link", () => {
    expect(walk('<a href="https://x.io">link</a>').typst).toBe('#link("https://x.io")[link]');
  });
  it("link where text equals href -> bare #link()", () => {
    expect(walk('<a href="https://x.io">https://x.io</a>').typst).toBe('#link("https://x.io")');
  });
  it("br -> line break", () => {
    expect(walk("a<br>b").typst).toBe("a\\\nb");
  });
  it("span bold via style", () => {
    expect(walk('<span style="font-weight:bold">x</span>').typst).toBe("*x*");
  });
  it("span italic via style", () => {
    expect(walk('<span style="font-style:italic">x</span>').typst).toBe("_x_");
  });
  it("img -> placeholder + pendingImage", () => {
    const { typst, wctx } = walk('<img src="data:image/png;base64,iVBOR" alt="d">');
    expect(typst).toMatch(/^\u0000IMG0\u0000$/);
    expect(wctx.pendingImages).toHaveLength(1);
  });
});
