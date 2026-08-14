import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { useSetting } from "../../hooks/useSetting";
import { useThemeStore } from "../../store/themeStore";
import { markPageDecoded } from "../../lib/compileTiming";
import { SvgPage } from "./SvgPage";
import { rectsByPageForLines } from "./previewSearch";
import type { LineRect } from "../../lib/types";

interface PreviewPaneProps {
  svgPages: string[];
  /** Source line → page-rect map, from the last `compiled` event. */
  lineMap?: LineRect[];
  activeLines?: number[];
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
  /**
   * The revision these `svgPages` correspond to (DIAGNOSTIC: used by
   * compileTiming to attribute blob-decode latency per compile cycle). Optional
   * so existing callers that don't care about timing still compile.
   */
  revision?: number;
  /** Ref onto the scroll container (`.preview-pane`). */
  paneRef?: React.Ref<HTMLDivElement>;
  /** Refs to each `.svg-page` wrapper, indexed by 0-based page number. */
  pageRefs?: React.RefObject<(HTMLDivElement | null)[]>;
  // --- Source-driven preview search (see previewSearch.ts) -------------------
  /** 0-based source-line indices matching the query, for highlight overlays. */
  searchLines?: number[];
  /** The active match's 0-based line index (drives the stronger tint). */
  activeSearchLine?: number | null;
  /** Open/close the search bar (the magnifier toggle owns this state). */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  /** Step to the next/previous match (delta ±1); `null` match count hides nav. */
  onSearchStep?: (delta: 1 | -1) => void;
  /** Total match count (display "n/m"); 0 = no matches. */
  searchMatchCount?: number;
  /** 0-based index of the active match within the full match list. */
  searchActiveIndex?: number;
}

/**
 * Vertical scroll container for rendered typst pages. MVP renders all pages;
 * large documents can be virtualized later.
 *
 * Desk (surface) background: a dark UI theme (theme `base === "dark"`) drives
 * the desk dark using the theme's own `--color-canvas-parchment` token, so each
 * dark theme's tint applies. Separately, the `preview.background` setting still
 * forces a literal near-black desk (`#1e1e22`) when set to `"dark"` even under a
 * light theme — a manual override kept for backward compatibility. Light themes
 * with `preview.background === "light"` fall through to the `.preview-pane` CSS
 * rule (parchment). The page paper itself always stays white
 * (`--color-paper`) — a real page on a dark desk.
 */
export function PreviewPane({
  svgPages,
  lineMap,
  activeLines,
  onRefresh,
  onJumpToLine,
  onScroll,
  onPageImgLoad,
  revision,
  paneRef,
  pageRefs,
  searchLines,
  activeSearchLine,
  searchOpen = false,
  onSearchOpenChange,
  searchQuery = "",
  onSearchQueryChange,
  onSearchStep,
  searchMatchCount = 0,
  searchActiveIndex = -1,
}: PreviewPaneProps) {
  const { t } = useTranslation("preview");
  const [autoRefresh] = useSetting<boolean>("preview.autoRefresh");
  const [zoomLevel] = useSetting<number>("preview.zoomLevel");
  const [background] = useSetting<string>("preview.background");
  // The active UI theme's light/dark base. Drives the desk color so a dark
  // theme's own `--color-canvas-parchment` tint applies (each dark theme paints
  // the desk its own way). See the component doc comment for the full rules.
  const currentBase = useThemeStore((s) => s.currentBase);
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

  // Search-highlight buckets (all matches + the active match's own rects).
  const searchRectsByPage = useMemo(
    () => rectsByPageForLines(lineMap, searchLines ?? []),
    [lineMap, searchLines],
  );
  const activeSearchRectsByPage = useMemo(
    () =>
      activeSearchLine == null
        ? new Map<number, LineRect[]>()
        : rectsByPageForLines(lineMap, [activeSearchLine]),
    [lineMap, activeSearchLine],
  );

  // Focus the search input when the bar opens.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Inline style overrides on the `.preview-pane` container. Both the page-
  // edge padding (the gap between the page and the pane edges, incl. the
  // horizontal space on each side of a centered page) AND the vertical flex
  // `gap` between stacked pages are driven by the single `preview.padding`
  // setting — the old CSS hardcoded `padding: var(--space-sm)` (12px) and
  // `gap: var(--space-xs)` (8px), which read as a wide empty border. One
  // smaller value (default 4px) now controls both, keeping them consistent.
  //
  // Desk background rules (see component doc comment):
  //  - dark UI theme → the theme's own `--color-canvas-parchment` (per-theme tint)
  //  - light UI theme + `preview.background === "dark"` → literal `#1e1e22`
  //    (the legacy manual override)
  //  - otherwise unset → falls through to the `.preview-pane` CSS (parchment)
  const padPx = padding ?? 4;
  const themeDark = currentBase === "dark";
  const forcedDark = !themeDark && background === "dark";
  const surfaceStyle: React.CSSProperties = {
    padding: padPx,
    gap: padPx,
    ...(themeDark
      ? { background: "var(--color-canvas-parchment)" }
      : forcedDark
        ? { background: "#1e1e22" }
        : undefined),
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

  // Stable per-index onImgLoad closure, for the same memo-preservation reason
  // as `refForPage`: an inline `() => onPageImgLoad(i)` here would be a NEW
  // function reference on every render, defeating `SvgPage`'s `memo` even when
  // the page's SVG string is unchanged (which would wrongly trigger a blob
  // rebuild for unchanged pages — the exact cost incremental rendering avoids).
  //
  // The closure captures `onPageImgLoad` and `revision`, which change across
  // renders — so we invalidate the whole cache when either changes (cheaper
  // than per-entry invalidation, and these change rarely: revision changes once
  // per compile, onPageImgLoad only if the parent re-wires it).
  const imgLoadCache = useRef<Map<number, () => void>>(new Map());
  const imgLoadDeps = useRef<{ onPageImgLoad: typeof onPageImgLoad; revision: number | undefined }>(
    { onPageImgLoad, revision },
  );
  if (
    imgLoadDeps.current.onPageImgLoad !== onPageImgLoad ||
    imgLoadDeps.current.revision !== revision
  ) {
    imgLoadCache.current = new Map();
    imgLoadDeps.current = { onPageImgLoad, revision };
  }
  const onImgLoadForPage = useCallback(
    (i: number): (() => void) | undefined => {
      if (!onPageImgLoad && revision == null) return undefined;
      let fn = imgLoadCache.current.get(i);
      if (!fn) {
        fn = () => {
          // Read the LATEST onPageImgLoad/revision at call time via the deps
          // ref, so a cached closure never fires a stale callback.
          if (imgLoadDeps.current.revision != null) {
            markPageDecoded(imgLoadDeps.current.revision, i + 1);
          }
          imgLoadDeps.current.onPageImgLoad?.(i);
        };
        imgLoadCache.current.set(i, fn);
      }
      return fn;
    },
    // Stable: the cache + deps-ref absorb the changing values. The body reads
    // through imgLoadDeps.current so it always uses the latest.
    [],
  );

  return (
    <div
      ref={paneRef}
      className="preview-pane"
      style={surfaceStyle}
      onScroll={onScroll}
    >
      {/* Top chrome: refresh (autoRefresh off), the search toggle, and the
          search bar share ONE sticky container — separate sticky siblings
          would pile onto the same top:0 rect and cover each other once the
          pane scrolls. */}
      <div className="preview-chrome">
        <div className="preview-chrome-row">
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
          {onSearchOpenChange && (
            <button
              type="button"
              className={
                "preview-tool-button" + (searchOpen ? " is-active" : "")
              }
              title={t("search.toggleTitle")}
              aria-pressed={searchOpen}
              onClick={() => onSearchOpenChange(!searchOpen)}
            >
              <Search size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {searchOpen && (
          <div className="preview-searchbar">
            <input
              ref={searchInputRef}
              type="text"
              className="preview-search-input"
              placeholder={t("search.placeholder")}
              value={searchQuery}
              onChange={(e) => onSearchQueryChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSearchStep?.(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onSearchOpenChange?.(false);
                }
              }}
              aria-label={t("search.placeholder")}
            />
            <span className="preview-search-count">
              {searchMatchCount > 0
                ? t("search.count", {
                    active: searchActiveIndex + 1,
                    total: searchMatchCount,
                  })
                : searchQuery.trim() !== ""
                  ? t("search.noMatches")
                  : ""}
            </span>
            <button
              type="button"
              className="preview-tool-button"
              title={t("search.prev")}
              disabled={searchMatchCount === 0}
              onClick={() => onSearchStep?.(-1)}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="preview-tool-button"
              title={t("search.next")}
              disabled={searchMatchCount === 0}
              onClick={() => onSearchStep?.(1)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="preview-tool-button"
              title={t("search.close")}
              onClick={() => onSearchOpenChange?.(false)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
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
            activeLines={activeLines}
            onJumpToLine={onJumpToLine}
            searchRects={searchRectsByPage.get(i)}
            activeSearchRects={activeSearchRectsByPage.get(i)}
            onImgLoad={onImgLoadForPage(i)}
            pageRef={refForPage(i)}
          />
        ))
      )}
    </div>
  );
}
