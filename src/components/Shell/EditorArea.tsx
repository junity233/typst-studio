import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { TabStrip } from "../TitleBar/TabStrip";
import { MonacoEditor } from "../Editor/MonacoEditor";
import { editorApiRef } from "../Editor/editorApiRef";
import { FormatToolbar } from "../FormatToolbar/FormatToolbar";
import { PreviewPane } from "../Preview/PreviewPane";
import { DiagnosticsPanel } from "../Diagnostics/DiagnosticsPanel";
import { useTabsStore, useActiveDocument } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useUiStore } from "../../store/uiStore";
import { useSetting } from "../../hooks/useSetting";
import { updateText } from "../../lib/tauri";
import {
  lineAtOrAboveY,
  parseViewBoxPt,
  rectAtOrBeforeLine,
} from "../Preview/previewMapping";
import { isZoomWheel, nextZoomStep } from "../../hooks/useWheelZoom";

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

const ZOOM_CLEANUP_KEY = "_zoomCleanup" as keyof HTMLElement;

/**
 * Attach a capture-phase Ctrl/Cmd+wheel zoom listener to an element, mirroring
 * the per-pane zoom behavior. Shared by the editor-font-size and preview-zoom
 * panes. `get` reads the live value, `set` persists it, and `min`/`max`/`step`
 * /`fallback` configure the clamp — the value math delegates to the tested
 * {@link nextZoomStep} so it stays in one place.
 *
 * The listener is attached in the capture phase so it intercepts the wheel
 * event before Monaco (which installs its own) or the preview's scroll
 * container can consume it. The cleanup fn is stashed on the element so React's
 * callback ref can detach it on unmount/re-bind (React calls the ref with null
 * on the old node before the new one).
 */
function attachZoomListener(
  el: HTMLDivElement,
  get: () => number | undefined,
  set: (next: number) => void,
  opts: { min: number; max: number; step: number; fallback: number },
): void {
  const onWheel = (e: globalThis.WheelEvent) => {
    if (!isZoomWheel(e)) return;
    const current = get() ?? opts.fallback;
    const next = nextZoomStep(current, e.deltaY, opts);
    if (next === current) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  el.addEventListener("wheel", onWheel, { passive: false, capture: true });
  (el as unknown as Record<string, unknown>)[ZOOM_CLEANUP_KEY] = () => {
    el.removeEventListener("wheel", onWheel, { capture: true });
  };
}

/** Detach any listener previously attached via {@link attachZoomListener}. */
function detachZoomListener(el: HTMLElement | null): void {
  if (el && typeof el[ZOOM_CLEANUP_KEY] === "function") {
    (el[ZOOM_CLEANUP_KEY] as unknown as () => void)();
    delete el[ZOOM_CLEANUP_KEY];
  }
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
  const { t } = useTranslation("editor");
  const activeTab = useActiveDocument();
  const [cursorPreviewState, setCursorPreviewState] = useState<{
    tabId: string;
    line: number;
  } | null>(null);
  // Live active-tab id for use inside stable/deferred closures (rAF callbacks)
  // that must read the CURRENT doc without rebuilding on every keystroke.
  const activeTabIdRef = useRef<string | null>(activeTab?.id ?? null);
  activeTabIdRef.current = activeTab?.id ?? null;
  const updateContent = useTabsStore((s) => s.updateContent);
  const previewVisible = useUiStore((s) => s.previewVisible);
  const setPreview = useUiStore((s) => s.setPreview);

  const [diagsCollapsed, setDiagsCollapsed] = useState(false);
  // NOTE: `editorApiRef` is the module-scoped ref from ../Editor/editorApiRef,
  // lifted out of a local useRef so the Search panel (and other cross-cutting
  // callers) can invoke `revealLine` to jump to a location. It is mutated in
  // place (no re-render), matching the old local-ref behavior.
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
  // The preview-pane padding (user setting, default 4px) is also the anchor
  // offset for scroll-sync: the synced line/rect sits this many px below the
  // pane's top edge. Reading it here keeps the anchor in lockstep with the
  // actual padding so alignment stays exact at any padding value.
  const [previewPadding] = useSetting<number>("preview.padding");
  const [autoRefresh] = useSetting<boolean>("preview.autoRefresh");
  // "Compile caught up" (compiledRevision >= revision) is read from the store
  // at kick time inside the re-align paths below, not computed here — see the
  // re-align effect / handlePageImgLoad comments for why gating on it prevents
  // mis-aligning against a stale lineMap during fast typing.

  // --- Ctrl/Cmd+wheel zoom (per-pane, persisted via settings) -------------
  // Editor pane: editor.fontSize [8,32] step 1 (manifest default 13).
  // Preview pane: preview.zoomLevel [0.25,4] step 0.1 (manifest default 1).
  // The setters go through set_setting IPC → backend broadcasts settings_changed
  // → all useSetting subscribers re-render → Monaco applies fontSize via
  // updateOptions, preview applies zoomLevel via SvgPage's CSS `zoom`.
  const [editorFontSize, setEditorFontSize] = useSetting<number>("editor.fontSize");
  const [previewZoomLevel, setPreviewZoomLevel] = useSetting<number>("preview.zoomLevel");
  // Keep live value in a ref so the native capture-phase wheel listener (which
  // can't be a React synthetic handler) always reads the latest setting.
  const editorFontSizeRef = useRef(editorFontSize);
  editorFontSizeRef.current = editorFontSize;
  // Like the editor pane, attach a capture-phase native wheel listener so
  // Ctrl+wheel is intercepted before the `.preview-pane` scroll container
  // starts scrolling (its overflow-y:auto can consume the event before the
  // React bubble-phase onWheel fires). Live value via ref.
  const previewZoomLevelRef = useRef(previewZoomLevel);
  previewZoomLevelRef.current = previewZoomLevel;
  // Keep live value in a ref so the native capture-phase wheel listener (which
  // can't be a React synthetic handler) always reads the latest setting.
  // Like the editor pane, attach a capture-phase native wheel listener so
  // Ctrl+wheel is intercepted before the `.preview-pane` scroll container
  // starts scrolling (its overflow-y:auto can consume the event before the
  // React bubble-phase onWheel fires). Live value via ref.
  const previewPaneZoomRef = useCallback(
    (el: HTMLDivElement | null) => {
      detachZoomListener(el);
      if (el === null) return;
      attachZoomListener(
        el,
        () => previewZoomLevelRef.current,
        setPreviewZoomLevel,
        { min: 0.25, max: 4, step: 0.25, fallback: 1 },
      );
    },
    [setPreviewZoomLevel],
  );

  // Monaco adds its own capture-phase wheel listener INSIDE its DOM; a React
  // bubble-phase onWheel on `.pane-editor` would lose the race. Attach a native
  // capture-phase listener on the pane div so we intercept Ctrl+wheel BEFORE
  // it reaches Monaco, and call preventDefault to stop Monaco's zoom/scroll.
  //
  // Uses a callback ref (not useRef + useEffect) so the listener attaches the
  // moment the `.pane-editor` div mounts — which is LATER than the first render
  // (the div only exists when `activeTab !== null`, i.e. after session restore
  // loads a document). A plain useEffect keyed on [setEditorFontSize] would run
  // once before the div exists and never re-run. On unmount (React calls the
  // ref with null), the stashed cleanup detaches the listener.
  const editorPaneRef = useCallback(
    (el: HTMLDivElement | null) => {
      detachZoomListener(el);
      if (el === null) return;
      attachZoomListener(
        el,
        () => editorFontSizeRef.current,
        setEditorFontSize,
        { min: 8, max: 32, step: 1, fallback: 14 },
      );
    },
    [setEditorFontSize],
  );

  // Scroll-sync reads/writes `scrollTop` on this ref, so it MUST point at the
  // actual scroll container (`.preview-pane`, `overflow: auto`). It is therefore
  // populated SOLELY by `PreviewPane`'s `paneRef` prop — NOT by the `.pane-preview`
  // wrapper's callback ref below, which would otherwise overwrite it with the
  // non-scrolling ancestor and silently break both sync directions (scrollTop
  // reads as 0 forever; writes move nothing).
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  // The `.pane-preview` wrapper is NOT the scroll container; it only hosts the
  // capture-phase Ctrl+wheel zoom listener (which must sit ABOVE the scroll
  // container to intercept before it). Kept separate so it can't clobber the
  // scroll ref above.
  const panePreviewWrapperRef = useRef<HTMLDivElement | null>(null);
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
  // is anchored. Equals the preview-pane's top padding so the top line sits
  // just inside the content area, not flush against the border. Used by BOTH
  // directions so the invariant is symmetric:
  //   editor-top-line N  ⇄  preview rect for N at paneTop + ANCHOR_PX.
  // Kept in a ref because the scroll-sync mappers are stable `useCallback([])`
  // closures that must read the LIVE padding (it's user-configurable) without
  // rebuilding — same pattern as lineMapRef / svgPagesRef above.
  const anchorPxRef = useRef(previewPadding ?? 4);
  anchorPxRef.current = previewPadding ?? 4;
  // Per-frame easing factor for the interpolated follow. 0.6 = move 60% of the
  // remaining gap each frame; converges in ~3 frames (~50ms) — fast enough to
  // feel nearly instantaneous, yet eased enough that fast scrolls don't look
  // like hard jumps. (1.0 would snap instantly and feel jittery under rapid
  // input; 0.3 was perceptibly laggy.)
  const EASE = 0.6;
  // When no user scroll has arrived for this long (ms), switch from eased
  // following to absolute alignment so the two panes are exactly in sync at
  // rest (corrects any drift accumulated during fast scrolling, where events
  // may coalesce/skip). This is NOT "the scroll fully stopped" — inertial and
  // discrete-wheel scrolling can stretch event gaps past this threshold while
  // the driver is still creeping; the SETTLE_FRAMES check below handles that.
  const IDLE_MS = 150;
  // After the idle threshold trips, keep the loop alive and re-snap each frame
  // until the driver-derived target has held steady for this many consecutive
  // frames. Inertial / slow-mouse-wheel scrolls emit scroll events with growing
  // gaps near the tail; a single idle frame could land mid-deceleration, snap
  // the follower to a transient position, and leave a residual offset when the
  // next delayed event re-kicks. Requiring the target to settle kills that.
  const SETTLE_FRAMES = 3;

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
      if (imgRect.height === 0) continue;
      out.push({
        offsetTop: el.offsetTop,
        pxPerPt: imgRect.height / ptSize.height,
        ptHeight: ptSize.height,
      });
    }
    pageMetrics.current = out;
  }, []);

  // Given the editor's top visible line, return the preview scrollTop that puts
  // that line's rect at `anchorPxRef.current` (= preview padding) below the
  // preview's top edge.
  const previewScrollTopForLine = useCallback(
    (topLine: number): number | null => {
      const rect = rectAtOrBeforeLine(lineMapRef.current, topLine);
      if (!rect) return null;
      const m = pageMetrics.current[rect.page];
      if (!m) return null;
      return m.offsetTop + rect.y * m.pxPerPt - anchorPxRef.current;
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
    // The anchor in content coords = scrollTop + anchor (px from the top of
    // the scrollable content), where `anchor` equals the pane's top padding.
    // Find the page that contains this offset.
    const anchor = anchorPxRef.current;
    const anchorContentY = pane.scrollTop + anchor;
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
    return api.getLineTopOffset(hit.line) - anchorPxRef.current;
  }, []);

  // --- Interpolated sync engine ------------------------------------------
  // One of "editor" | "preview" | null: which pane the USER is currently
  // scrolling. The other pane is the one we ease toward its target.
  const driverRef = useRef<"editor" | "preview" | null>(null);
  const lastUserScrollAt = useRef(0);
  const animRaf = useRef<number | null>(null);
  // Settling bookkeeping (see SETTLE_FRAMES). `lastAppliedRef` holds the value
  // most recently written to the follower, so the ease step has a stable basis
  // even when the follower's queried position lags a frame (Monaco's
  // setScrollTop updates its scroll state asynchronously → getScrollTop() can
  // still read the pre-apply value next frame, inflating `gap` and causing
  // overshoot oscillation). `settleTargetRef` / `settleCountRef` track how long
  // the driver-derived target has held still during the post-idle snap phase.
  const lastAppliedRef = useRef<number | null>(null);
  const settleTargetRef = useRef<number | null>(null);
  const settleCountRef = useRef(0);

  // Set the driven pane, refresh the target, and start the easing loop if it
  // isn't already running. Called on every user scroll event.
  const kick = useCallback((driver: "editor" | "preview") => {
    driverRef.current = driver;
    lastUserScrollAt.current = performance.now();
    // A new user event ends any prior settling phase: reset the steady-target
    // tracker so the loop can re-arm the snap once the driver stops again.
    settleTargetRef.current = null;
    settleCountRef.current = 0;
    // Refresh cached page metrics (offsetTop/pxPerPt) so the target math uses
    // the current layout rather than stale geometry from a prior zoom/resize.
    refreshPageMetrics();
    if (animRaf.current == null) {
      animRaf.current = requestAnimationFrame(tick);
    }
  }, [refreshPageMetrics]);

  // The per-frame step: ease the follower toward its target, then either
  // schedule another frame or finalize (absolute snap) once idle AND the
  // driver-derived target has held steady for SETTLE_FRAMES frames.
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
    const idle = performance.now() - lastUserScrollAt.current >= IDLE_MS;

    // Wrap the apply so the follower's echo scroll events are ignored (they'd
    // otherwise re-kick the loop in the opposite direction → ping-pong). Both a
    // synchronous flag (covers in-call events) and a timestamp (covers Monaco's
    // deferred scroll events) are armed. Also stash the applied value so the
    // next ease step has a stable basis even when the follower's queried
    // position lags a frame (Monaco setScrollTop updates asynchronously).
    const apply = (v: number) => {
      lastAppliedRef.current = v;
      applyingRef.current = true;
      applyingUntil.current = performance.now() + APPLY_GUARD_MS;
      try {
        applyRaw(v);
      } finally {
        applyingRef.current = false;
      }
    };

    if (idle) {
      // No user event for IDLE_MS: snap the follower to the driver's position.
      // But this is not necessarily the REST position — inertial and slow
      // discrete-wheel scrolls can stretch event gaps past IDLE_MS mid-glide.
      // So instead of snapping once and bailing, keep re-snapping every frame
      // until the target has held steady for SETTLE_FRAMES consecutive frames
      // (only then is the driver truly at rest). This absorbs residual inertia
      // creep that previously left the panes offset after fast scrolling.
      apply(target);
      if (settleTargetRef.current === target) {
        settleCountRef.current += 1;
      } else {
        settleTargetRef.current = target;
        settleCountRef.current = 1;
      }
      if (settleCountRef.current >= SETTLE_FRAMES) {
        // Driver genuinely settled: stop the loop. The panes are now exact.
        settleTargetRef.current = null;
        settleCountRef.current = 0;
        return;
      }
      animRaf.current = requestAnimationFrame(tick);
      return;
    }
    // Not idle: ease toward the (moving) target. Re-arm every frame while the
    // user is still scrolling so we keep up; convergence isn't the goal here —
    // the idle branch above does the final exact alignment. Basis for the ease
    // is the LAST APPLIED value, not the freshly queried follower position: the
    // latter can lag a frame after a programmatic scroll (Monaco), and reading
    // it here would inflate `gap`, overshoot, and oscillate — a drift source at
    // rest. `lastAppliedRef` falls back to `current` on the very first frame.
    const basis = lastAppliedRef.current ?? current;
    const easeGap = target - basis;
    const next = basis + easeGap * EASE;
    apply(next);
    animRaf.current = requestAnimationFrame(tick);
  };

  // Guard so the follower's own scroll events don't re-trigger the loop in the
  // opposite direction. Two layers:
  //  (a) `applyingRef` is set synchronously around each programmatic scroll, so
  //      events fired *during* the apply are ignored.
  //  (b) `applyingUntil` is a timestamp: some scroll events (Monaco's
  //      setScrollTop in particular) fire asynchronously, after `apply()`
  //      returns. We keep the guard armed for a short window after each apply
  //      so those deferred echoes don't flip the driver and start a ping-pong.
  // Together these prevent the oscillation where editor→preview moves the
  // preview, whose echo re-kicks as preview→editor, etc.
  const applyingRef = useRef(false);
  const applyingUntil = useRef(0);
  // How long after a programmatic apply to keep ignoring follower echoes.
  const APPLY_GUARD_MS = 80;

  const isApplying = useCallback(() => {
    return applyingRef.current || performance.now() < applyingUntil.current;
  }, []);

  // Editor → preview: the editor is the driver.
  useEffect(() => {
    if (!scrollSyncOn) return;
    const api = editorApiRef.current;
    if (!api) return;
    const dispose = api.onDidScrollChange((topLine) => {
      // Ignore echoes of our own programmatic editor scroll (preview driving).
      if (isApplying()) return;
      void topLine;
      kick("editor");
    });
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSyncOn, editorReadyTick, kick, isApplying]);

  // Preview → editor: the preview is the driver.
  const handlePreviewScroll = useCallback(() => {
    if (!scrollSyncOn) return;
    // Ignore echoes of our own programmatic preview scroll (editor driving).
    if (isApplying()) return;
    kick("preview");
  }, [scrollSyncOn, kick, isApplying]);

  // Keep `pageMetrics` fresh AND re-align after geometry changes. A recompile,
  // zoom change, or tab switch reflows the preview pages, which (a) invalidates
  // the cached offsetTop/pxPerPt and (b) — for recompiles — changes the source-
  // line → page-rect map entirely, leaving the two panes silently out of sync
  // until the user scrolls. We close both:
  //
  //  (1) This effect re-runs on every geometry-changing input and defers the
  //      refresh + re-align two rAFs so the just-rendered <img> has decoded.
  //      Two frames (not one): the first lets SvgPage's [svg] effect run and
  //      set the new blob URL; the second lets the <img> actually decode it.
  //  (2) SvgPage's <img onLoad> (→ `onPageImgLoad` → `handlePageImgLoad`) is the
  //      backstop: it fires once per page once decoding truly completes, with a
  //      guaranteed-non-zero height, and re-aligns then too.
  // Re-alignment drives from the EDITOR (the authority — the user edits there),
  // so the preview snaps to the editor's current top line under the new layout.
  // Guarded by `scrollSyncOn` + a live editor API + the compile being caught up
  // (see `compileCaughtUp`): we read it from the store at kick time (not at
  // effect-setup time) because the user may type more during the 2-frame rAF
  // delay, making a previously-fresh lineMap stale again.
  useEffect(() => {
    // Track both rAF ids so cleanup cancels whichever is pending.
    const ids: number[] = [];
    const schedule = (fn: () => void) => {
      const id = requestAnimationFrame(fn);
      ids.push(id);
    };
    schedule(() => {
      schedule(() => {
        refreshPageMetrics();
        // Only re-align when the shown preview reflects the current buffer;
        // otherwise the lineMap is stale (edits outpaced the compile) and
        // snapping would actively MIS-align. Scroll-follow still runs against
        // whatever lineMap exists when the user scrolls — best effort.
        const doc = activeTabIdRef.current;
        const d = doc ? useDocumentsStore.getState().documents[doc] : undefined;
        const caughtUp = !!d && d.compiledRevision >= d.revision;
        if (scrollSyncOn && caughtUp && editorApiRef.current) {
          kick("editor");
        }
      });
    });
    return () => {
      for (const id of ids) cancelAnimationFrame(id);
    };
  }, [
    activeTab?.id,
    activeTab?.svgPages,
    activeTab?.lineMap,
    previewZoomLevel,
    previewVisible,
    refreshPageMetrics,
    scrollSyncOn,
    kick,
  ]);

  // Cleanup the animation loop on unmount.
  useEffect(() => {
    return () => {
      if (animRaf.current != null) cancelAnimationFrame(animRaf.current);
    };
  }, []);

  useEffect(() => {
    if (!prevPreviewVisible.current && previewVisible && activeTab) {
      void updateText(
        activeTab.id,
        activeTab.content,
        activeTab.revision,
      ).catch((e) =>
        console.warn("[EditorArea] preview-open recompile failed:", e),
      );
    }
    prevPreviewVisible.current = previewVisible;
  }, [previewVisible, activeTab]);

  // Event delivery is intentionally best-effort in the Tauri emitter. Heal a
  // missed `compiled` event by replaying the SAME versioned snapshot until the
  // preview catches up. The backend treats equal revision + equal content as a
  // recompile, while its stale guard makes an old retry harmless after a newer
  // edit. Compile errors stop retries because retaining the last good preview
  // is the intended error behavior.
  useEffect(() => {
    if (
      !previewVisible ||
      autoRefresh === false ||
      !activeTab ||
      activeTab.status === "error" ||
      activeTab.compiledRevision >= activeTab.revision
    ) {
      return;
    }

    const { id, content, revision } = activeTab;
    let cancelled = false;
    let timer: number | null = null;
    let delay = 1_000;

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        const live = useDocumentsStore.getState().documents[id];
        if (
          !live ||
          live.revision !== revision ||
          live.content !== content ||
          live.status === "error" ||
          live.compiledRevision >= revision
        ) {
          return;
        }
        try {
          await updateText(id, content, revision);
        } catch (error) {
          console.warn("[EditorArea] preview reconciliation failed:", error);
        }
        if (!cancelled) {
          delay = Math.min(delay * 2, 5_000);
          schedule();
        }
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    previewVisible,
    autoRefresh,
    activeTab?.id,
    activeTab?.content,
    activeTab?.revision,
    activeTab?.compiledRevision,
    activeTab?.status,
  ]);

  useEffect(() => {
    const api = editorApiRef.current;
    if (!api || !activeTab) {
      setCursorPreviewState(null);
      return;
    }
    const sync = () => {
      setCursorPreviewState({
        tabId: activeTab.id,
        line: api.getCurrentLine(),
      });
    };
    sync();
    return api.onDidChangeCursorPosition(sync);
  }, [editorReadyTick, activeTab?.id]);

  const activePreviewLine =
    activeTab &&
    activeTab.compiledRevision >= activeTab.revision &&
    cursorPreviewState?.tabId === activeTab.id
      ? cursorPreviewState.line
      : null;

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
    void updateText(
      activeTab.id,
      activeTab.content,
      activeTab.revision,
    ).catch((e) =>
      console.warn("[EditorArea] manual refresh failed:", e),
    );
  };

  // Each page's <img> finishes decoding its blob URL once per compile (SvgPage
  // revokes + recreates the URL on every `svg` change). At that moment the
  // rendered height is finally non-zero, so this is the reliable signal to
  // re-read page geometry — AND to re-align the preview, since a recompile can
  // reflow the document (the source-line → page-rect map changes entirely) and
  // leave the two panes silently out of sync until the user scrolls. Re-aligning
  // here, with the editor as the driver, makes the preview follow the new layout
  // immediately. Gated on the compile being caught up (see the re-align effect
  // above): if edits outpaced the compile, the lineMap is stale and snapping
  // would mis-align; we refresh metrics (cheap, helps the next scroll) but skip
  // the kick.
  const handlePageImgLoad = useCallback(() => {
    refreshPageMetrics();
    const id = activeTabIdRef.current;
    const d = id ? useDocumentsStore.getState().documents[id] : undefined;
    const caughtUp = !!d && d.compiledRevision >= d.revision;
    if (scrollSyncOn && caughtUp && editorApiRef.current) {
      kick("editor");
    }
  }, [refreshPageMetrics, scrollSyncOn, kick]);

  return (
    <div className="editor-area">
      <div className="editor-area-header">
        <TabStrip />
        <button
          className="preview-toggle"
          type="button"
          onClick={() => setPreview(!previewVisible)}
          title={previewVisible ? t("preview.hide") : t("preview.show")}
          aria-pressed={previewVisible}
        >
          {previewVisible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
      <FormatToolbar
        api={editorApiRef.current}
        tab={activeTab}
        disabled={activeTab === null}
      />
      <main className="editor-area-main">
        {activeTab === null ? (
          <div className="pane pane-empty">{t("noDocument")}</div>
        ) : (
          <div
            ref={containerRef}
            className={"editor-split" + (previewVisible ? "" : " preview-hidden")}
          >
            <div className="pane pane-editor" ref={editorPaneRef}>
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
              ref={(el) => {
                // NOTE: this is the .pane-preview WRAPPER, not the scroll
                // container. Only the zoom listener attaches here; the scroll
                // ref is owned by PreviewPane's `paneRef` (→ .preview-pane) so
                // the two can't clobber each other.
                panePreviewWrapperRef.current = el;
                previewPaneZoomRef(el);
              }}
            >
              <PreviewPane
                svgPages={activeTab.svgPages}
                lineMap={activeTab.lineMap}
                activeLine={activePreviewLine}
                onRefresh={handleRefresh}
                onJumpToLine={handleJumpToLine}
                onScroll={handlePreviewScroll}
                onPageImgLoad={handlePageImgLoad}
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
