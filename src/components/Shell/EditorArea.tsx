import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { TabStrip } from "../TitleBar/TabStrip";
import { MonacoEditor, type MonacoEditorApi } from "../Editor/MonacoEditor";
import { PreviewPane } from "../Preview/PreviewPane";
import { DiagnosticsPanel } from "../Diagnostics/DiagnosticsPanel";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { updateText } from "../../lib/tauri";

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
  const prevPreviewVisible = useRef(previewVisible);

  const [previewWidth, setPreviewWidth] = useState<number>(loadPreviewWidth);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest width for the drag closure to read without going stale / rebuilding.
  const previewWidthRef = useRef(previewWidth);
  previewWidthRef.current = previewWidth;

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
                onRefresh={handleRefresh}
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
