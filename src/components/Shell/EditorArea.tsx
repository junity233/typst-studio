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
  // Per-frame easing factor for the interpolated follow. 0.6 = move 60% of the
  // remaining gap each frame; converges in ~3 frames (~50ms) — fast enough to
  // feel nearly instantaneous, yet eased enough that fast scrolls don't look
  // like hard jumps. (1.0 would snap instantly and feel jittery under rapid
  // input; 0.3 was perceptibly laggy.)
  const EASE = 0.6;
  // When no user scroll has arrived for this long (ms), force a final absolute
  // alignment so the two panes are exactly in sync at rest (corrects any drift
  // accumulated during fast scrolling, where events may coalesce/skip).
  const IDLE_MS = 150;

  // --- Cross-domain mapping helpers (source line ⇄ preview scrollTop) -----
  // Both helpers work in *logical* scroll coordinates (pane.scrollTop / editor
  // getScrollTop), NOT getBoundingClientRect(). Reason: the rect reflects the
  // compositor's rendered position, which can lag the logical scrollTop by a
  // frame during fast/inertial scrolling — that lag is what made the final
  // resting position drift. The lineMap is static per-compile, so mapping
  // through it is deterministic and compositor-independent.

  // Cache of each page wrapper's offsetTop + px-per-pt, rebuilt when pages
  // change. Reading offsetTop/getBoundingClientRect once per page (lazily) is
  // fine; we avoid re-reading them every animation frame.
  const pageMetrics = useRef<
    { offsetTop: number; pxPerPt: number; ptHeight: number }[]
  >([]);

  // Refresh the cached page metrics from the live DOM. Called at the start of
  // each sync kick so offsets reflect the current layout (zoom, pane width).
  const refreshPageMetrics = useCallback(() => {
    const out: { offsetTop: number; pxPerPt: number; ptHeight: number }[] = [];
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (!el) continue;
      const img = el.querySelector(
        "img.svg-page-img",
      ) as HTMLImageElement | null;
      const ptSize = parseViewBoxPt(svgPagesRef.current[i] ?? "");
      if (!img || !ptSize || ptSize.height === 0) continue;
      const imgRect = img.getBoundingClientRect();
      out.push({
        offsetTop: el.offsetTop,
        pxPerPt: imgRect.height / ptSize.height,
        ptHeight: ptSize.height,
      });
    }
    pageMetrics.current = out;
  }, []);

  // Given the editor's top visible line, return the preview scrollTop that puts
  // that line's rect at ANCHOR_PX below the preview's top edge.
  const previewScrollTopForLine = useCallback(
    (topLine: number): number | null => {
      const rect = rectAtOrBeforeLine(lineMapRef.current, topLine);
      if (!rect) return null;
      const m = pageMetrics.current[rect.page];
      if (!m) return null;
      return m.offsetTop + rect.y * m.pxPerPt - ANCHOR_PX;
    },
    [],
  );

  // Given the preview's current scrollTop, return the editor scrollTop that
  // aligns the source line at the preview's anchor to the editor's top. We go
  // preview scrollTop → pt → source line → editor pixel via the editor's own
  // line metrics.
  const editorScrollTopForPreview = useCallback((): number | null => {
    const api = editorApiRef.current;
    const pane = previewPaneRef.current;
    if (!api || !pane) return null;
    // The anchor in content coords = scrollTop + ANCHOR_PX (px from the top of
    // the scrollable content). Find the page that contains this offset.
    const anchorContentY = pane.scrollTop + ANCHOR_PX;
    let leadPage = -1;
    for (let i = 0; i < pageMetrics.current.length; i++) {
      const m = pageMetrics.current[i];
      // A page spans [offsetTop, offsetTop + ptHeight*pxPerPt). The gap between
      // pages (var(--space-xs)) is small; treat the anchor as "in" the last
      // page whose top is at/above it.
      if (m.offsetTop <= anchorContentY) leadPage = i;
      else break;
    }
    if (leadPage < 0) return null;
    const m = pageMetrics.current[leadPage];
    const ptY = (anchorContentY - m.offsetTop) / m.pxPerPt;
    const hit = lineAtOrAboveY(
      lineMapRef.current.filter((lr) => lr.page === leadPage),
      ptY,
    );
    if (!hit) return null;
    // Map the source line into an editor pixel offset.
    return api.getLineTopOffset(hit.line) - ANCHOR_PX;
  }, []);

  // --- Interpolated sync engine ------------------------------------------
  // One of "editor" | "preview" | null: which pane the USER is currently
  // scrolling. The other pane is the one we ease toward its target.
  const driverRef = useRef<"editor" | "preview" | null>(null);
  const lastUserScrollAt = useRef(0);
  const animRaf = useRef<number | null>(null);

  // Set the driven pane, refresh the target, and start the easing loop if it
  // isn't already running. Called on every user scroll event.
  const kick = useCallback((driver: "editor" | "preview") => {
    driverRef.current = driver;
    lastUserScrollAt.current = performance.now();
    // Refresh cached page metrics (offsetTop/pxPerPt) so the target math uses
    // the current layout rather than stale geometry from a prior zoom/resize.
    refreshPageMetrics();
    if (animRaf.current == null) {
      animRaf.current = requestAnimationFrame(tick);
    }
  }, [refreshPageMetrics]);

  // The per-frame step: ease the follower toward its target, then either
  // schedule another frame or finalize (absolute snap) once idle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tick = () => {
    animRaf.current = null;
    const driver = driverRef.current;
    const api = editorApiRef.current;
    const pane = previewPaneRef.current;
    if (!driver || !api || !pane) return;

    // Refresh the target from the driver's CURRENT position (the user may still
    // be scrolling, so the target moves each frame).
    let target: number | null;
    let applyRaw: (v: number) => void;
    let current: number;
    if (driver === "editor") {
      target = previewScrollTopForLine(api.getTopVisibleLine());
      current = pane.scrollTop;
      applyRaw = (v) => {
        pane.scrollTop = v;
      };
    } else {
      target = editorScrollTopForPreview();
      current = api.getScrollTop();
      applyRaw = (v) => api.setScrollTop(v);
    }
    if (target == null) return;
    target = Math.max(0, target);
    const gap = target - current;
    const idle = performance.now() - lastUserScrollAt.current >= IDLE_MS;

    // Wrap the apply so the follower's echo scroll events are ignored (they'd
    // otherwise re-kick the loop in the opposite direction → ping-pong).
    const apply = (v: number) => {
      applyingRef.current = true;
      try {
        applyRaw(v);
      } finally {
        applyingRef.current = false;
      }
    };

    if (idle) {
      // Scroll settled: absolute-align to the driver's final position, killing
      // any residual drift from eased/inertial scrolling. Always apply (no gap
      // threshold) so the resting position is exact.
      apply(target);
      return;
    }
    // Not idle: ease toward the (moving) target. Re-arm every frame while the
    // user is still scrolling so we keep up; convergence isn't the goal here —
    // the idle branch above does the final exact alignment.
    const next = current + gap * EASE;
    apply(next);
    animRaf.current = requestAnimationFrame(tick);
  };

  // Guard so the follower's own scroll events don't re-trigger the loop in the
  // opposite direction. While we're applying positions in `tick`, the follower
  // emits scroll events; those must not become new "user scrolls". We track the
  // active driver and ignore scroll events that originate from the follower.
  const applyingRef = useRef(false);

  // Editor → preview: the editor is the driver.
  useEffect(() => {
    if (!scrollSyncOn) return;
    const api = editorApiRef.current;
    if (!api) return;
    const dispose = api.onDidScrollChange((topLine) => {
      // Ignore echoes of our own programmatic editor scroll (preview driving).
      if (applyingRef.current) return;
      void topLine;
      kick("editor");
    });
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSyncOn, editorReadyTick, kick]);

  // Preview → editor: the preview is the driver.
  const handlePreviewScroll = useCallback(() => {
    if (!scrollSyncOn) return;
    // Ignore echoes of our own programmatic preview scroll (editor driving).
    if (applyingRef.current) return;
    kick("preview");
  }, [scrollSyncOn, kick]);

  // Cleanup the animation loop on unmount.
  useEffect(() => {
    return () => {
      if (animRaf.current != null) cancelAnimationFrame(animRaf.current);
    };
  }, []);

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
