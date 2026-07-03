import { useCallback, useMemo, useRef } from "react";
import { useSetting } from "../../hooks/useSetting";
import { SvgPage } from "./SvgPage";
import type { LineRect } from "../../lib/types";

interface PreviewPaneProps {
  svgPages: string[];
  /** Source line → page-rect map, from the last `compiled` event. */
  lineMap?: LineRect[];
  /** Manual recompile trigger; shown only while `preview.autoRefresh` is off. */
  onRefresh?: () => void;
  /** Double-click a rendered line → jump editor cursor to that source line. */
  onJumpToLine?: (line: number) => void;
  /** Fired (rAF-throttled internally by the caller) on preview scroll. */
  onScroll?: () => void;
  /** Ref onto the scroll container (`.preview-pane`). */
  paneRef?: React.Ref<HTMLDivElement>;
  /** Refs to each `.svg-page` wrapper, indexed by 0-based page number. */
  pageRefs?: React.RefObject<(HTMLDivElement | null)[]>;
}

/**
 * Vertical scroll container for rendered typst pages. MVP renders all pages;
 * large documents can be virtualized later.
 *
 * Surface background follows `preview.background`: "light" keeps the parchment
 * canvas (via the `.preview-pane` CSS rule); "dark" overrides it with a literal
 * near-black desk surface (no dark token exists in the light-first palette).
 * The page paper itself always stays white — a real page on a dark desk.
 */
export function PreviewPane({
  svgPages,
  lineMap,
  onRefresh,
  onJumpToLine,
  onScroll,
  paneRef,
  pageRefs,
}: PreviewPaneProps) {
  const [autoRefresh] = useSetting<boolean>("preview.autoRefresh");
  const [zoomLevel] = useSetting<number>("preview.zoomLevel");
  const [background] = useSetting<string>("preview.background");

  // Bucket rects by page so each SvgPage only hit-tests its own lines.
  const rectsByPage = useMemo(() => {
    const buckets = new Map<number, LineRect[]>();
    if (lineMap) {
      for (const r of lineMap) {
        let arr = buckets.get(r.page);
        if (!arr) {
          arr = [];
          buckets.set(r.page, arr);
        }
        arr.push(r);
      }
    }
    return buckets;
  }, [lineMap]);

  const surfaceStyle =
    background === "dark" ? { background: "#1e1e22" } : undefined;
  const zoom = zoomLevel ?? 1;

  // Stable per-index ref-setters so `SvgPage`'s `memo` isn't defeated by a fresh
  // inline closure on every render. Each index's setter is created once and
  // reused across renders; `pageRefs` is a stable ref object so the closures
  // remain valid for the component's lifetime.
  const refCache = useRef<Map<number, (el: HTMLDivElement | null) => void>>(
    new Map(),
  );
  const refForPage = useCallback(
    (i: number): React.Ref<HTMLDivElement> => {
      let fn = refCache.current.get(i);
      if (!fn) {
        fn = (el: HTMLDivElement | null) => {
          if (pageRefs) pageRefs.current[i] = el;
        };
        refCache.current.set(i, fn);
      }
      return fn;
    },
    [pageRefs],
  );

  return (
    <div
      ref={paneRef}
      className="preview-pane"
      style={surfaceStyle}
      onScroll={onScroll}
    >
      {autoRefresh === false && onRefresh && (
        <button
          className="preview-refresh"
          type="button"
          onClick={onRefresh}
          title="Refresh preview"
        >
          Refresh
        </button>
      )}
      {svgPages.length === 0 ? (
        <div className="preview-empty">No preview yet</div>
      ) : (
        svgPages.map((svg, i) => (
          <SvgPage
            key={i}
            svg={svg}
            pageNumber={i + 1}
            zoom={zoom}
            lineRects={rectsByPage.get(i)}
            onJumpToLine={onJumpToLine}
            pageRef={refForPage(i)}
          />
        ))
      )}
    </div>
  );
}
