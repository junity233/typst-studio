import { memo, useEffect, useState } from "react";

interface SvgPageProps {
  svg: string;
  pageNumber: number;
  zoom?: number;
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
}: SvgPageProps) {
  const [url, setUrl] = useState<string>("");

  useEffect(() => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const newUrl = URL.createObjectURL(blob);
    setUrl(newUrl);
    return () => URL.revokeObjectURL(newUrl);
  }, [svg]);

  return (
    <div
      className="svg-page"
      data-page={pageNumber}
      style={zoom !== 1 ? { zoom } : undefined}
    >
      {url && (
        <img
          src={url}
          alt={`Page ${pageNumber}`}
          className="svg-page-img"
          draggable={false}
        />
      )}
    </div>
  );
});
