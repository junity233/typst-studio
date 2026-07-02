import type { WalkCtx } from "./types";
import { convertInline } from "./inline";

interface Row {
  cells: string[];
  isHeader: boolean;
}

export function convertTable(el: Element, wctx: WalkCtx): string {
  const rows: Row[] = [];
  let hasRowspan = false;

  el.querySelectorAll(":scope > tr, :scope > tbody > tr, :scope > thead > tr").forEach((tr) => {
    const cells: string[] = [];
    let rowIsHeader = true;
    tr.querySelectorAll(":scope > td, :scope > th").forEach((cell) => {
      const isHeaderCell = cell.tagName.toLowerCase() === "th";
      const colspan = Number(cell.getAttribute("colspan") ?? "1");
      const rowspan = cell.getAttribute("rowspan");
      const hasColspanAttr = colspan > 1;
      const hasRowspanAttr = rowspan !== null && Number(rowspan) > 1;
      const content = convertInline(cell, wctx).trim();
      if (content === "" && !hasColspanAttr && !hasRowspanAttr) {
        return;
      }
      if (!isHeaderCell) rowIsHeader = false;
      if (hasRowspanAttr) hasRowspan = true;
      cells.push(content);
      for (let i = 1; i < colspan; i++) cells.push("");
    });
    if (cells.length > 0) rows.push({ cells, isHeader: rowIsHeader });
  });

  const columns = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  if (hasRowspan) wctx.warnings.push("rowspan flattened (Typst #table has no row merge)");

  const headerRows = rows.filter((r) => r.isHeader);
  const bodyRows = rows.filter((r) => !r.isHeader);

  const pad = (r: Row) => {
    const c = [...r.cells];
    while (c.length < columns) c.push("");
    return c;
  };

  const parts: string[] = [`columns: ${columns}`];
  if (headerRows.length > 0) {
    const cells = headerRows.flatMap(pad).map((c) => `[${c}]`).join(", ");
    parts.push(`table.header(${cells})`);
  }
  bodyRows.forEach((r) => {
    parts.push(pad(r).map((c) => `[${c}]`).join(", "));
  });

  return "#table(\n  " + parts.join(",\n  ") + ",\n)";
}
