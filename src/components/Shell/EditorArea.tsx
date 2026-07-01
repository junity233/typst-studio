import { useRef, useState } from "react";
import { Allotment } from "allotment";
import { TabStrip } from "../TitleBar/TabStrip";
import { SplitPane } from "../SplitPane/SplitPane";
import { MonacoEditor, type MonacoEditorApi } from "../Editor/MonacoEditor";
import { PreviewPane } from "../Preview/PreviewPane";
import { DiagnosticsPanel } from "../Diagnostics/DiagnosticsPanel";
import { useTabsStore } from "../../store/tabsStore";

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

  const [diagsCollapsed, setDiagsCollapsed] = useState(false);
  const editorApiRef = useRef<MonacoEditorApi | null>(null);

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
            <Allotment.Pane minSize={200}>
              <div className="pane pane-preview">
                <PreviewPane svgPages={activeTab.svgPages} />
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
