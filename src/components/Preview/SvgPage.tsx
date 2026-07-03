import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LineRect } from "../../lib/types";
import { clientToPagePt, lineFromPoint, parseViewBoxPt } from "./previewMapping";

// `navigator.platform` reliably reports "MacIntel" / "iPhone" on Apple
// platforms in Tauri's WKWebView/WebView2; used only to pick the right
// shortcut hint in the tooltip (⌘ vs Ctrl).
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

interface SvgPageProps {
  svg: string;
  pageNumber: number;
  zoom?: number;
  /**
   * Source-line rects that fall on this page. Used for double-click
   * jump-to-source; empty if the page has no mapped text.
   */
  lineRects?: LineRect[];
  /** Invoked with a 1-indexed source line on double-click. */
  onJumpToLine?: (line: number) => void;
  /** Ref set to the page wrapper element (used by scroll-sync). */
  pageRef?: React.Ref<HTMLDivElement>;
}

/**
 * Renders a single typst-generated SVG page as a blob-URL `<img>`.
 *
 * **Why not `dangerouslySetInnerHTML`?** Inserting a large SVG (hundreds of KB)
 * inline forces the browser to **synchronously** parse the XML, build a DOM
 * tree, and run layout — all on the main thread, blocking Monaco keystroke
 * handling for 50–500 ms per compile.
 *
 * With a blob URL, the browser decodes the SVG **off-main-thread** (in its
 * image decoder) and the main thread only swaps an `img.src` (~microseconds).
 * This is the single biggest win for editor fluidity on large documents.
 *
 * Trade-off: the preview is no longer selectable text (it's a rasterized
 * bitmap). For MVP (viewing only) this is acceptable; text selection can be
 * re-added later via a hybrid approach (overlay transparent text layer).
 *
 * `zoom` is applied as the CSS `zoom` property (valid in Tauri's WKWebView and
 * WebView2/WebKitGTK): it scales the page box AND reflows the surrounding flex
 * column, so adjacent pages keep their spacing — unlike `transform: scale`,
 * which would overlap siblings.
 */
export const SvgPage = memo(function SvgPage({
  svg,
  pageNumber,
  zoom = 1,
  lineRects,
  onJumpToLine,
  pageRef,
}: SvgPageProps) {
  const [url, setUrl] = useState<string>("");
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Intrinsic page size in pt (from the SVG viewBox). Used for click→pt
  // conversion. We do NOT use img.naturalWidth/Height: those return CSS pixels
  // (pt × 96/72), which would inflate pt coordinates by ~1.333×. See
  // previewMapping.ts's coordinate-model doc for details.
  const ptSize = useMemo(() => parseViewBoxPt(svg), [svg]);

  useEffect(() => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const newUrl = URL.createObjectURL(blob);
    setUrl(newUrl);
    return () => URL.revokeObjectURL(newUrl);
  }, [svg]);

  // Cmd-click (macOS) / Ctrl-click (other platforms) jumps to the source line
  // under the cursor. Matches the editor convention for "go to definition".
  const handleJumpClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!onJumpToLine || !lineRects || lineRects.length === 0) return;
    // Only fire on the modifier-click — a plain click does nothing (so the user
    // can still interact/select without accidental jumps).
    if (!e.metaKey && !e.ctrlKey) return;
    const img = imgRef.current;
    if (!img || !ptSize) return;
    const rect = img.getBoundingClientRect();
    const pt = clientToPagePt(e.clientX, e.clientY, rect, ptSize.width, ptSize.height);
    if (!pt) return;
    const line = lineFromPoint(lineRects, pt.x, pt.y);
    if (line != null) onJumpToLine(line);
  };

  return (
    <div
      ref={pageRef}
      className="svg-page"
      data-page={pageNumber}
      style={zoom !== 1 ? { zoom } : undefined}
    >
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={`Page ${pageNumber}`}
          className={
            "svg-page-img" +
            (onJumpToLine && lineRects && lineRects.length > 0
              ? " is-jumpable"
              : "")
          }
          draggable={false}
          onClick={handleJumpClick}
          title={
            onJumpToLine && lineRects && lineRects.length > 0
              ? IS_MAC ? "⌘ Click to jump to source" : "Ctrl+Click to jump to source"
              : undefined
          }
        />
      )}
    </div>
  );
});
