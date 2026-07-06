import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
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
  /**
   * Fired when a page's rendered `<img>` finishes decoding its SVG blob. Used
   * by the scroll-sync owner to refresh page-geometry cache at the moment the
   * rendered height becomes non-zero (the blob decode is async, so geometry
   * read at render time is still height:0). Receives the 0-based page index.
   */
  onPageImgLoad?: (pageIndex: number) => void;
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
  onPageImgLoad,
  paneRef,
  pageRefs,
}: PreviewPaneProps) {
  const { t } = useTranslation("preview");
  const [autoRefresh] = useSetting<boolean>("preview.autoRefresh");
  const [zoomLevel] = useSetting<number>("preview.zoomLevel");
  const [background] = useSetting<string>("preview.background");
  // User-configurable padding around the rendered pages (manifest default 4px —
  // tighter than the old CSS `var(--space-sm)` 12px so the page nearly fills the
  // pane without a wide empty border). Applied inline to override the CSS rule.
  const [padding] = useSetting<number>("preview.padding");

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

  // Inline style overrides on the `.preview-pane` container. Both the page-
  // edge padding (the gap between the page and the pane edges, incl. the
  // horizontal space on each side of a centered page) AND the vertical flex
  // `gap` between stacked pages are driven by the single `preview.padding`
  // setting — the old CSS hardcoded `padding: var(--space-sm)` (12px) and
  // `gap: var(--space-xs)` (8px), which read as a wide empty border. One
  // smaller value (default 4px) now controls both, keeping them consistent.
  // `background` is only set for the dark surface variant — the light
  // parchment comes from the CSS rule and stays unset here.
  const padPx = padding ?? 4;
  const surfaceStyle: React.CSSProperties = {
    padding: padPx,
    gap: padPx,
    ...(background === "dark" ? { background: "#1e1e22" } : undefined),
  };
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
          title={t("refreshPreview")}
        >
          {t("refresh")}
        </button>
      )}
      {svgPages.length === 0 ? (
        <div className="preview-empty">{t("noPreview")}</div>
      ) : (
        svgPages.map((svg, i) => (
          <SvgPage
            key={i}
            svg={svg}
            pageNumber={i + 1}
            zoom={zoom}
            lineRects={rectsByPage.get(i)}
            onJumpToLine={onJumpToLine}
            onImgLoad={onPageImgLoad ? () => onPageImgLoad(i) : undefined}
            pageRef={refForPage(i)}
          />
        ))
      )}
    </div>
  );
}
