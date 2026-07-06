/**
 * Geometry helpers mapping between source lines, preview-page points (in pt),
 * and rendered `<img>` pixels. Shared by click-to-source and scroll-sync so
 * both use one consistent coordinate model.
 *
 * ## Coordinate model
 *
 * Backend `LineRect`s are in Typst's page space: **points, y-down**, origin at
 * the page top-left — identical to the `<svg viewBox>` typst-svg emits.
 *
 * **Unit pitfall (the bug this guards against):** the SVG's `width`/`height`
 * attributes are in pt (`width="283.46pt"`), but `img.naturalWidth`/
 * `naturalHeight` return the intrinsic size in **CSS pixels** — i.e. the pt
 * value scaled by 96/72 ≈ 1.333. Using `naturalWidth` as the pt-space width
 * therefore inflates every pt coordinate by 4/3, landing clicks ~33% too far
 * down/right. Instead we parse the `viewBox` (which is in pt) and scale against
 * the rendered pixel size. CSS `zoom` is absorbed automatically: it scales the
 * rendered `getBoundingClientRect()` box but not the viewBox, so the pt-per-px
 * ratio stays correct under any zoom.
 */

import type { LineRect } from "../../lib/types";

/**
 * Parse a typst-svg string's intrinsic page size in pt, from its `viewBox`
 * attribute. typst-svg always emits `viewBox="0 0 W H"` with W,H in pt (matching
 * the `width`/`height` pt attributes). Returns `null` if the viewBox is absent
 * or unparseable.
 */
export function parseViewBoxPt(svg: string): {
  width: number;
  height: number;
} | null {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  // viewBox = "minX minY width height"; we want the size (last two).
  return { width: parts[2], height: parts[3] };
}

/**
 * Convert a click position (clientX/clientY) into page-space pt, given the
 * rendered `<img>` rectangle and the SVG's intrinsic pt size (from `parseViewBoxPt`).
 *
 * Returns `null` if the pt size is missing/zero.
 */
export function clientToPagePt(
  clientX: number,
  clientY: number,
  imgRect: DOMRect,
  ptWidth: number,
  ptHeight: number,
): { x: number; y: number } | null {
  if (ptWidth === 0 || ptHeight === 0 || imgRect.width === 0) return null;
  // pt-per-rendered-px. CSS `zoom` scales imgRect.width but not ptWidth, so the
  // ratio stays correct under any zoom setting.
  const scale = ptWidth / imgRect.width;
  return {
    x: (clientX - imgRect.left) * scale,
    y: (clientY - imgRect.top) * scale,
  };
}

/**
 * Find the `LineRect` containing a page-space point, falling back to the
 * nearest one by distance-to-center. Used by double-click jump-to-source.
 *
 * Returns the matched rect's `line`, or `null` if there are no rects at all.
 */
export function lineFromPoint(
  rects: readonly LineRect[],
  x: number,
  y: number,
): number | null {
  if (rects.length === 0) return null;

  // 1. Direct containment (cheap, common case: click lands on text).
  for (const r of rects) {
    if (
      x >= r.x &&
      x <= r.x + r.w &&
      y >= r.y &&
      y <= r.y + r.h
    ) {
      return r.line;
    }
  }

  // 2. Nearest by distance to rect center (click just outside a line, e.g. in
  // the gutter or between wrapped fragments of the same line).
  let bestLine = rects[0].line;
  let bestDist = Infinity;
  for (const r of rects) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = x - cx;
    const dy = y - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = r.line;
    }
  }
  return bestLine;
}

/**
 * Find the `LineRect` whose top edge is at or above a given page-space Y, on a
 * given page — i.e. the source line currently at the top of the viewport when
 * scrolled to `(page, ptY)`. Used by preview→editor scroll-sync.
 *
 * `rects` must be pre-filtered to the relevant page. Returns `null` if none.
 */
export function lineAtOrAboveY(
  rects: readonly LineRect[],
  ptY: number,
): LineRect | null {
  let candidate: LineRect | null = null;
  for (const r of rects) {
    if (r.y <= ptY) {
      // This line sits at or above the scroll position.
      if (candidate === null || r.y > candidate.y) candidate = r;
    }
  }
  return candidate;
}

/**
 * Find the last `LineRect` at or before a 1-indexed source line — i.e. the
 * preview position corresponding to the editor's current top line. Used by
 * editor→preview scroll-sync. Returns `null` if `rects` is empty.
 */
export function rectAtOrBeforeLine(
  rects: readonly LineRect[],
  line: number,
): LineRect | null {
  let candidate: LineRect | null = null;
  for (const r of rects) {
    if (r.line <= line) {
      if (candidate === null || r.line > candidate.line) candidate = r;
    }
  }
  return candidate;
}

/**
 * Return every preview rect that belongs to a given 1-indexed source line.
 *
 * A single source line can map to multiple preview fragments (wrapped text,
 * separate inline boxes, etc.), so callers that want to visually mark "the
 * current line" should operate on the full set rather than a single rect.
 */
export function rectsForLine(
  rects: readonly LineRect[],
  line: number,
): LineRect[] {
  return rects.filter((r) => r.line === line);
}

/**
 * Return the union bounds of a set of preview rects, or `null` when empty.
 *
 * Used by the preview overlay's page-edge marker so multiple fragments of the
 * same source line can share one quiet vertical rail.
 */
export function lineRectBounds(
  rects: readonly LineRect[],
): { x: number; y: number; w: number; h: number } | null {
  if (rects.length === 0) return null;
  let minX = rects[0].x;
  let minY = rects[0].y;
  let maxX = rects[0].x + rects[0].w;
  let maxY = rects[0].y + rects[0].h;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}
