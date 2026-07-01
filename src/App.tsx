import { useEffect, useRef, useState } from "react";
import { Allotment } from "allotment";
import { SplitPane } from "./components/SplitPane/SplitPane";
import { TabStrip } from "./components/TitleBar/TabStrip";
import { TitleBar } from "./components/TitleBar/TitleBar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { MonacoEditor, type MonacoEditorApi } from "./components/Editor/MonacoEditor";
import { PreviewPane } from "./components/Preview/PreviewPane";
import { DiagnosticsPanel } from "./components/Diagnostics/DiagnosticsPanel";
import { useTypstCompile } from "./hooks/useTypstCompile";
import { initTabs, useTabsStore } from "./store/tabsStore";

export default function App() {
  useTypstCompile();

  const activeTab = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.activeId) ?? null,
  );
  const updateContent = useTabsStore((s) => s.updateContent);

  const [diagsCollapsed, setDiagsCollapsed] = useState(false);
  const editorApiRef = useRef<MonacoEditorApi | null>(null);

  // Ensure at least one tab exists on first load.
  useEffect(() => {
    void initTabs();
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <TabStrip />
      <main className="app-main">
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
      <StatusBar />
    </div>
  );
}
