import { useRef, useState } from "react";
import { Allotment } from "allotment";
import { TabStrip } from "../TitleBar/TabStrip";
import { SplitPane } from "../SplitPane/SplitPane";
import { MonacoEditor, type MonacoEditorApi } from "../Editor/MonacoEditor";
import { PreviewPane } from "../Preview/PreviewPane";
import { DiagnosticsPanel } from "../Diagnostics/DiagnosticsPanel";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { updateText } from "../../lib/tauri";

/**
 * The editor area: tab strip on top, then a vertical split of (editor|preview)
 * with a collapsible diagnostics panel at the bottom. This is the right-hand
 * pane of the Workbench; it knows nothing about the sidebar/workspace.
 */
export function EditorArea() {
  const activeTab = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.activeId) ?? null,
  );
  const updateContent = useTabsStore((s) => s.updateContent);
  const previewVisible = useUiStore((s) => s.previewVisible);

  const [diagsCollapsed, setDiagsCollapsed] = useState(false);
  const editorApiRef = useRef<MonacoEditorApi | null>(null);

  // Manual preview refresh: re-pushes the current source to the backend
  // compile pipeline. Shown only while `preview.autoRefresh` is off (handled
  // in PreviewPane). `activeTab` is non-null wherever this is invoked.
  const handleRefresh = () => {
    if (activeTab === null) return;
    void updateText(activeTab.id, activeTab.content).catch((e) =>
      console.warn("[EditorArea] manual refresh failed:", e),
    );
  };

  return (
    <div className="editor-area">
      <TabStrip />
      <main className="editor-area-main">
        {activeTab === null ? (
          <div className="pane pane-empty">No document open</div>
        ) : (
          <SplitPane>
            <Allotment.Pane minSize={200}>
              <div className="pane pane-editor">
                <MonacoEditor
                  tab={activeTab}
                  onChange={(value) => updateContent(activeTab.id, value)}
                  onReady={(api) => {
                    editorApiRef.current = api;
                  }}
                />
              </div>
            </Allotment.Pane>
            <Allotment.Pane
              minSize={0}
              preferredSize={previewVisible ? undefined : 0}
              maxSize={previewVisible ? undefined : 0}
              visible={previewVisible}
              snap
            >
              <div className="pane pane-preview">
                <PreviewPane
                  svgPages={activeTab.svgPages}
                  onRefresh={handleRefresh}
                />
              </div>
            </Allotment.Pane>
          </SplitPane>
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
