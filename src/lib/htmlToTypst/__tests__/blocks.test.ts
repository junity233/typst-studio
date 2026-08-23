import { describe, it, expect } from "vitest";
import { convertBlocks } from "../blocks";
import { makeWalkCtx } from "../types";

function walk(html: string) {
  const wctx = makeWalkCtx({ imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return convertBlocks(doc.body, wctx, 0).trim();
}

describe("convertBlocks", () => {
  it("h1..h3 levels", () => {
    expect(walk("<h1>Title</h1>")).toBe("= Title");
    expect(walk("<h2>Sub</h2>")).toBe("== Sub");
    expect(walk("<h3>Deep</h3>")).toBe("=== Deep");
  });
  it("paragraphs separated by blank line", () => {
    expect(walk("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
  });
  it("unknown block container keeps child paragraphs separated", () => {
    // Regression pin: Word's clipboard wraps content in `<section>`/`<article>`
    // etc.; the old inline fallback flattened a multi-paragraph section into
    // one run-on paragraph. Children must convert as BLOCKS.
    expect(walk("<section><p>one</p><h2>Head</h2></section>")).toBe(
      "one\n\n== Head",
    );
  });
  it("unordered list", () => {
    expect(walk("<ul><li>a<li>b</ul>")).toBe("- a\n- b");
  });
  it("ordered list", () => {
    expect(walk("<ol><li>a<li>b</ol>")).toBe("+ a\n+ b");
  });
  it("nested list indents two spaces", () => {
    expect(walk("<ul><li>a<ul><li>b</ul></ul>")).toBe("- a\n  - b");
  });
  it("blockquote -> #quote", () => {
    expect(walk("<blockquote>hi</blockquote>")).toBe("#quote[hi]");
  });
  it("pre with language -> code block", () => {
    expect(walk('<pre><code class="language-rust">fn x()</code></pre>')).toBe(
      "```rust\nfn x()\n```",
    );
  });
  it("pre without language -> plain code block", () => {
    expect(walk("<pre>raw code</pre>")).toBe("```\nraw code\n```");
  });
  it("pre containing ``` widens the fence so content cannot close the block", () => {
    // P0 pin: a fixed ``` fence would let pasted code containing ``` terminate
    // the raw block early, re-injecting the trailing text as LIVE markup (a
    // `#include`/`#read` injection vector). The fence must outgrow the longest
    // backtick run in the content.
    expect(walk("<pre>```\n#read('secret')\n```</pre>")).toBe(
      "````\n```\n#read('secret')\n```\n````",
    );
  });
  it("list item starting with a block marker is escaped", () => {
    // P0 pin: `<li>= x</li>` sits right after the "- " marker; without escaping
    // Typst re-parses "= x" as a nested heading inside the list item line.
    expect(walk("<ul><li>= not-a-heading</li></ul>")).toBe("- \\= not-a-heading");
    expect(walk("<ul><li>+ plus</li></ul>")).toBe("- \\+ plus");
    expect(walk("<ul><li>- minus</li></ul>")).toBe("- \\- minus");
  });
  it("hr -> line", () => {
    expect(walk("<hr>")).toBe("#line(length: 100%)");
  });
  it("inline inside paragraph preserved", () => {
    expect(walk("<p><b>bold</b> text</p>")).toBe("*bold* text");
  });
  it("text node is escaped", () => {
    expect(walk("a*b")).toBe("a\\*b");
  });
});
