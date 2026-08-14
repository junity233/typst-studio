import type { LineRect } from "../../lib/types";

/**
 * Source-driven preview search.
 *
 * Why line-based: typst's SVG export renders text as GLYPH OUTLINES (`<use>`
 * refs into path defs — no `<text>` nodes), so there is nothing in the
 * rendered preview to select or string-search. What the app DOES have is the
 * compiler's lineMap (source line → page rects). Searching the PREVIEW
 * therefore means searching the preview document's SOURCE and highlighting
 * the rects of the matching lines — precise to the line, which is exactly
 * the "find it on the page, then fix it in the source" proofreading loop.
 */

/**
 * Indices (0-based) of the lines containing `query` as a case-insensitive
 * substring. An empty/whitespace query matches nothing. Pure.
 */
export function findMatchingLines(
  lines: readonly string[],
  query: string,
): number[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(q)) hits.push(i);
  }
  return hits;
}

/**
 * Bucket the lineMap rects for the given 0-based line indices by page, for
 * per-page highlight overlays. Pure.
 */
export function rectsByPageForLines(
  lineMap: readonly LineRect[] | undefined,
  lines: readonly number[],
): Map<number, LineRect[]> {
  const wanted = new Set(lines);
  const buckets = new Map<number, LineRect[]>();
  if (lineMap === undefined) return buckets;
  for (const r of lineMap) {
    // LineRect.line is 1-indexed; the input lines are 0-based indices.
    if (!wanted.has(r.line - 1)) continue;
    let arr = buckets.get(r.page);
    if (arr === undefined) {
      arr = [];
      buckets.set(r.page, arr);
    }
    arr.push(r);
  }
  return buckets;
}

/**
 * Clamp an active-match index into `[0, count)`; -1 when there are no
 * matches. Guards prev/next navigation when the match list shrinks under a
 * new query. Pure.
 */
export function clampActiveIndex(index: number, count: number): number {
  if (count === 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return ((index % count) + count) % count;
}
