/**
 * Build a Typst `#table(...)` snippet for an R×C grid of empty cells.
 *
 * Each cell is `[ ]` (single space content) so the table renders with
 * non-zero cell dimensions; the user fills them in after insert.
 *
 * Output format matches `src/lib/htmlToTypst/tables.ts` (the paste converter):
 *   #table(
 *     columns: <cols>,
 *     [ ], [ ],  ← row 1
 *     [ ], [ ],  ← row 2
 *   )
 *
 * Rows are emitted one per line (each row's cells comma-separated on a single
 * line); a trailing comma follows the final row (Typst permits it, and the
 * converter does the same). Extracted as a pure helper so the snippet shape is
 * unit-testable without rendering the picker.
 *
 * Edge cases: callers should pass positive integers. Inputs of 0 are tolerated
 * (a degenerate but syntactically valid `#table()` is produced) rather than
 * throwing — the grid picker enforces 1..8, but the helper stays defensive.
 */
export function buildTableSnippet(rows: number, cols: number): string {
  const safeCols = Math.max(0, Math.floor(cols));
  const safeRows = Math.max(0, Math.floor(rows));

  const parts: string[] = [`columns: ${safeCols}`];
  // Only emit row lines when there's at least one column — a 0-col row would be
  // bare whitespace (invalid Typst), so the degenerate case is just `#table(
  // columns: 0,)` with no rows. Parts carry no leading indentation; the join
  // below inserts the two-space indent uniformly (matches tables.ts).
  if (safeCols > 0) {
    const rowLine = Array.from({ length: safeCols }, () => "[ ]").join(", ");
    for (let r = 0; r < safeRows; r++) {
      parts.push(rowLine);
    }
  }
  return "#table(\n  " + parts.join(",\n  ") + ",\n)";
}
