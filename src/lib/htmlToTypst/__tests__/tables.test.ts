import { describe, it, expect } from "vitest";
import { convertTable } from "../tables";
import { makeWalkCtx } from "../types";

function table(html: string) {
  const wctx = makeWalkCtx({ imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { typst: convertTable(doc.querySelector("table")!, wctx), wctx };
}

describe("convertTable", () => {
  it("simple 2x2", () => {
    expect(table("<table><tr><td>A<td><td>B<td></tr><tr><td>1<td>2<td></tr></table>").typst)
      .toBe("#table(\n  columns: 2,\n  [A], [B],\n  [1], [2],\n)");
  });
  it("infers columns from widest row", () => {
    expect(table("<table><tr><td>a<td>b<td>c</tr><tr><td>x<td>y</tr></table>").typst)
      .toContain("columns: 3");
  });
  it("header row via th", () => {
    const { typst } = table("<table><tr><th>H1<th>H2</tr><tr><td>1<td>2</tr></table>");
    expect(typst).toContain("table.header([H1], [H2])");
  });
  it("colspan -> first cell content, rest empty", () => {
    const { typst } = table('<table><tr><td colspan="2">merged<td></tr><tr><td>a<td>b</tr></table>');
    expect(typst).toContain("columns: 2");
    expect(typst).toContain("[merged], []");
  });
  it("rowspan flattened + warning", () => {
    const { typst, wctx } = table('<table><tr><td rowspan="2">x<td>y</tr><tr><td>z</tr></table>');
    expect(typst).toContain("columns: 2");
    expect(wctx.warnings.some((w) => w.includes("rowspan"))).toBe(true);
  });
  it("inline markup in cells preserved", () => {
    const { typst } = table("<table><tr><td><b>x</b></tr></table>");
    expect(typst).toContain("[*x*]");
  });
});
