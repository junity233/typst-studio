import { describe, it, expect } from "vitest";
import { htmlToTypst } from "../index";

const ctx = { imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true };

describe("htmlToTypst", () => {
  it("end-to-end article", () => {
    const html = "<h1>Title</h1><p>Para with <b>bold</b> and <a href=\"https://x.io\">link</a>.</p><ul><li>a<li>b</ul>";
    const r = htmlToTypst(html, ctx);
    expect(r.typst).toBe("= Title\n\nPara with *bold* and #link(\"https://x.io\")[link].\n\n- a\n- b");
    expect(r.pendingImages).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
  it("word html is cleaned then converted", () => {
    const html = '<p class="MsoNormal" style="mso-foo: bar">Hi <b>x</b></p>';
    const r = htmlToTypst(html, ctx);
    expect(r.typst).toBe("Hi *x*");
  });
  it("trims leading/trailing blank lines", () => {
    const r = htmlToTypst("<p>a</p>", ctx);
    expect(r.typst).toBe("a");
  });
});
