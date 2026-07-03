import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { TabStrip } from "../TitleBar/TabStrip";
import { MonacoEditor, type MonacoEditorApi } from "../Editor/MonacoEditor";
import { PreviewPane } from "../Preview/PreviewPane";
import { DiagnosticsPanel } from "../Diagnostics/DiagnosticsPanel";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useSetting } from "../../hooks/useSetting";
import { updateText } from "../../lib/tauri";
import {
  lineAtOrAboveY,
  parseViewBoxPt,
  rectAtOrBeforeLine,
} from "../Preview/previewMapping";

const PREVIEW_WIDTH_KEY = "ts-preview-width";
const PREVIEW_WIDTH_DEFAULT = 480;
const PREVIEW_WIDTH_MIN = 240;

function loadPreviewWidth(): number {
  try {
    const raw = localStorage.getItem(PREVIEW_WIDTH_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= PREVIEW_WIDTH_MIN) return n;
    }
  } catch {
    // ignore
  }
  return PREVIEW_WIDTH_DEFAULT;
}

/**
 * The editor area: tab strip on top, then a horizontal split of (editor|preview)
 * with a collapsible diagnostics panel at the bottom. This is the right-hand
 * pane of the Workbench; it knows nothing about the sidebar/workspace.
 *
 * The editor|preview split is a hand-rolled flex row with a draggable sash
 * (Allotment's nested `visible` toggling proved unreliable for show/hide here).
 * The preview width is persisted to localStorage and clamped to a sensible min.
 */
export function EditorArea() {
  const activeTab = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.activeId) ?? null,
  );
  const updateContent = useTabsStore((s) => s.updateContent);
  const previewVisible = useUiStore((s) => s.previewVisible);
  const setPreview = useUiStore((s) => s.setPreview);

  const [diagsCollapsed, setDiagsCollapsed] = useState(false);
  const editorApiRef = useRef<MonacoEditorApi | null>(null);
  // Bumped when the editor API becomes available, so the scroll-sync effect can
  // (re)subscribe reactively (refs don't trigger re-renders).
  const [editorReadyTick, setEditorReadyTick] = useState(0);
  const prevPreviewVisible = useRef(previewVisible);

  const [previewWidth, setPreviewWidth] = useState<number>(loadPreviewWidth);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest width for the drag closure to read without going stale / rebuilding.
  const previewWidthRef = useRef(previewWidth);
  previewWidthRef.current = previewWidth;

  // --- Scroll-sync & click-to-source wiring -------------------------------
  const [scrollSync] = useSetting<boolean>("preview.scrollSync");
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  // A single guard shared by both sync directions. While a programmatic scroll
  // is in flight, the scroll listener it triggers is ignored so editor↔preview
  // can't ping-pong. Cleared on the next animation frame: Monaco uses
  // ScrollType.Immediate (synchronous), so its echo scroll event fires within
  // the same frame; a single rAF is sufficient and keeps the suppression window
  // minimal so genuine user input is honored immediately after.
  const syncingRef = useRef(false);
  const syncingRaf = useRef<number | null>(null);
  const armSyncGuard = useCallback(() => {
    syncingRef.current = true;
    if (syncingRaf.current != null) cancelAnimationFrame(syncingRaf.current);
    syncingRaf.current = requestAnimationFrame(() => {
      syncingRef.current = false;
      syncingRaf.current = null;
    });
  }, []);
  const scrollSyncOn = scrollSync !== false; // default true when unset
  // Latest lineMap + svg pages for use inside stable callbacks.
  const lineMapRef = useRef(activeTab?.lineMap ?? []);
  lineMapRef.current = activeTab?.lineMap ?? [];
  const svgPagesRef = useRef<string[]>(activeTab?.svgPages ?? []);
  svgPagesRef.current = activeTab?.svgPages ?? [];

  const handleJumpToLine = useCallback((line: number) => {
    editorApiRef.current?.revealLine(line, 1);
  }, []);

  // Vertical offset (px) below the pane's top edge where the synced line/rect
  // is anchored. Matches the preview-pane's top padding (var(--space-sm) = 12px)
  // so the top line sits just inside the content area, not flush against the
  // border. Used by BOTH directions so the invariant is symmetric:
  //   editor-top-line N  ⇄  preview rect for N at paneTop + ANCHOR_PX.
  const ANCHOR_PX = 12;

  // Editor → preview: scroll the preview so the rect for the editor's top
  // visible line sits at ANCHOR_PX below the preview's top edge.
  useEffect(() => {
    if (!scrollSyncOn) return;
    const api = editorApiRef.current;
    if (!api) return;
    const dispose = api.onDidScrollChange((topLine) => {
      if (syncingRef.current) return;
      const pane = previewPaneRef.current;
      if (!pane) return;
      const rect = rectAtOrBeforeLine(lineMapRef.current, topLine);
      if (!rect) return;
      const pageEl = pageRefs.current[rect.page];
      const img = pageEl?.querySelector(
        "img.svg-page-img",
      ) as HTMLImageElement | null;
      // Use the SVG viewBox (pt), NOT img.naturalHeight (which is CSS px =
      // pt × 96/72 and would inflate the offset). See previewMapping.ts.
      const ptSize = parseViewBoxPt(svgPagesRef.current[rect.page] ?? "");
      if (!img || !ptSize || ptSize.height === 0) return;
      const imgRect = img.getBoundingClientRect();
      const pxPerPt = imgRect.height / ptSize.height;
      // Where the target line's top currently sits in the viewport.
      const targetViewportY = imgRect.top + rect.y * pxPerPt;
      const paneTop = pane.getBoundingClientRect().top;
      const delta = targetViewportY - paneTop - ANCHOR_PX;
      if (Math.abs(delta) < 2) return;
      armSyncGuard();
      pane.scrollBy({ top: delta });
    });
    return dispose;
  }, [scrollSyncOn, editorReadyTick, armSyncGuard]);

  // Preview → editor: scroll the editor so the source line whose rect is at the
  // preview's top edge (paneTop + ANCHOR_PX) becomes the top visible line.
  // rAF-throttled so rapid scrolls coalesce into one editor move per frame.
  const previewScrollRaf = useRef<number | null>(null);
  const handlePreviewScroll = useCallback(() => {
    if (syncingRef.current || !scrollSyncOn) return;
    if (previewScrollRaf.current != null) return;
    previewScrollRaf.current = requestAnimationFrame(() => {
      previewScrollRaf.current = null;
      // Re-check the guard inside the rAF: a programmatic editor→preview
      // scroll during the one-frame deferral may have armed it, and acting
      // here would fight that scroll.
      if (syncingRef.current) return;
      const pane = previewPaneRef.current;
      const api = editorApiRef.current;
      if (!pane || !api) return;
      const anchorViewportY = pane.getBoundingClientRect().top + ANCHOR_PX;
      // Find the page whose top is at/above the anchor (the one scrolled to the
      // top edge). Pages are laid out top-to-bottom in a flex column, so the
      // first one whose top is below the anchor ends the search.
      let leadPage = -1;
      for (let i = 0; i < pageRefs.current.length; i++) {
        const el = pageRefs.current[i];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= anchorViewportY) leadPage = i;
        else break;
      }
      if (leadPage < 0) return;
      // Read geometry from the <img> (the paper), not the `.svg-page` wrapper,
      // so pxPerPt matches the editor→preview direction and click-to-source.
      // Use the SVG viewBox (pt), NOT img.naturalHeight (CSS px = pt × 96/72).
      const ptSize = parseViewBoxPt(svgPagesRef.current[leadPage] ?? "");
      const img = pageRefs.current[leadPage]?.querySelector(
        "img.svg-page-img",
      ) as HTMLImageElement | null;
      if (!img || !ptSize || ptSize.height === 0) return;
      const imgRect = img.getBoundingClientRect();
      const pxPerPt = imgRect.height / ptSize.height;
      const ptY = (anchorViewportY - imgRect.top) / pxPerPt;
      const rectsForPage = lineMapRef.current.filter((lr) => lr.page === leadPage);
      const hit = lineAtOrAboveY(rectsForPage, ptY);
      if (!hit) return;
      armSyncGuard();
      // Top-align (only when out of view) instead of center: centering on every
      // tick re-jumps the viewport and feels jittery; top-align produces a
      // smooth linear follow that mirrors the editor→preview direction.
      api.revealLineTopIfOutsideViewport(hit.line);
    });
  }, [scrollSyncOn, armSyncGuard]);

  useEffect(() => {
    if (!prevPreviewVisible.current && previewVisible && activeTab) {
      void updateText(activeTab.id, activeTab.content).catch((e) =>
        console.warn("[EditorArea] preview-open recompile failed:", e),
      );
    }
    prevPreviewVisible.current = previewVisible;
  }, [previewVisible, activeTab]);

  // Drag the sash: preview width = container right edge - pointer X. Uses
  // window-level pointer events so the drag survives the cursor leaving the
  // sash. Width persists to localStorage on pointerup.
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const w = rect.right - ev.clientX;
      const clamped = Math.max(
        PREVIEW_WIDTH_MIN,
        Math.min(w, rect.width - PREVIEW_WIDTH_MIN),
      );
      setPreviewWidth(clamped);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidthRef.current));
      } catch {
        // ignore
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);;

  const handleRefresh = () => {
    if (activeTab === null) return;
    void updateText(activeTab.id, activeTab.content).catch((e) =>
      console.warn("[EditorArea] manual refresh failed:", e),
    );
  };

  return (
    <div className="editor-area">
      <div className="editor-area-header">
        <TabStrip />
        <button
          className="preview-toggle"
          type="button"
          onClick={() => setPreview(!previewVisible)}
          title={previewVisible ? "Hide preview" : "Show preview"}
          aria-pressed={previewVisible}
        >
          {previewVisible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
      <main className="editor-area-main">
        {activeTab === null ? (
          <div className="pane pane-empty">No document open</div>
        ) : (
          <div
            ref={containerRef}
            className={"editor-split" + (previewVisible ? "" : " preview-hidden")}
          >
            <div className="pane pane-editor">
              <MonacoEditor
                tab={activeTab}
                onChange={(value) => updateContent(activeTab.id, value)}
                onReady={(api) => {
                  editorApiRef.current = api;
                  setEditorReadyTick((t) => t + 1);
                }}
              />
            </div>
            <div
              className="editor-sash"
              onPointerDown={startResize}
              role="separator"
              aria-orientation="vertical"
            />
            <div
              className="pane pane-preview"
              style={previewVisible ? { width: previewWidth, flex: "0 0 " + previewWidth + "px" } : undefined}
            >
              <PreviewPane
                svgPages={activeTab.svgPages}
                lineMap={activeTab.lineMap}
                onRefresh={handleRefresh}
                onJumpToLine={handleJumpToLine}
                onScroll={handlePreviewScroll}
                paneRef={previewPaneRef}
                pageRefs={pageRefs}
              />
            </div>
          </div>
        )}
      </main>
      <DiagnosticsPanel
        tabId={activeTab?.id}
        collapsed={diagsCollapsed}
        onToggle={() => setDiagsCollapsed((c) => !c)}
        onGoto={(range) =>
          editorApiRef.current?.revealLine(range.start_line, range.start_column)
        }
      />
    </div>
  );
}
