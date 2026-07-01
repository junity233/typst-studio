import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type * as Monaco from "monaco-editor";
import { saveFile, updateText } from "../../lib/tauri";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import type { Tab } from "../../store/tabsStore";
import { useDebouncedCallback } from "../../hooks/useDebounce";
import { registerTypstLanguage, setupMonaco } from "./typstLanguage";
import { toMonacoMarkers } from "./diagnostics";

/** Stable empty array so the selector returns the same reference when unset. */
const EMPTY_DIAGNOSTICS: readonly never[] = Object.freeze([]) as never[];

/** Imperative surface exposed to the parent for navigation (diagnostics goto). */
export interface MonacoEditorApi {
  revealLine: (line: number, column: number) => void;
}

interface MonacoEditorProps {
  tab: Tab;
  onChange: (value: string) => void;
  onReady?: (api: MonacoEditorApi) => void;
}

const MODEL_OWNER = "typst";

export function MonacoEditor({ tab, onChange, onReady }: MonacoEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const tabIdRef = useRef<string>(tab.id);
  tabIdRef.current = tab.id;

  const diagnostics = useDiagnosticsStore((s) =>
    s.byTab[tab.id] ?? EMPTY_DIAGNOSTICS,
  );

  // Setup + language registration run once before first mount.
  setupMonaco();

  // Debounced backend push. 100 ms feels instant while coalescing burst typing
  // into one IPC round-trip. Combined with the backend worker's 0 ms response,
  // total edit-to-preview latency ≈ 100 ms + compile time ≈ 150 ms.
  const pushToBackend = useDebouncedCallback((id: string, value: string) => {
    void updateText(id, value).catch((e) =>
      console.warn("[MonacoEditor] updateText failed:", e),
    );
  }, 100);

  const handleBeforeMount = (monaco: typeof Monaco): void => {
    registerTypstLanguage(monaco);
    // Light theme. Apple's system is fundamentally light; the editor reads on
    // white. Token colors are conservative and readable on white — not VS
    // Code defaults. Action Blue is reused for typst headings (navigational).
    monaco.editor.defineTheme("typst-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "931868", fontStyle: "italic" },
        { token: "keyword.heading", foreground: "0066cc" },
        { token: "type.identifier", foreground: "7a4400" },
        { token: "number", foreground: "1d1d1f" },
        { token: "string", foreground: "065d2c" },
        { token: "comment", foreground: "7a7a7a", fontStyle: "italic" },
        { token: "operator", foreground: "1d1d1f" },
        { token: "strong", foreground: "1d1d1f", fontStyle: "bold" },
        { token: "emphasis", foreground: "1d1d1f", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#ffffff",
      },
    });
  };

  const handleMount = (
    ed: editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
  ): void => {
    editorRef.current = ed;
    monacoRef.current = monaco;

    // Cmd/Ctrl+S → save the currently active tab.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveFile(tabIdRef.current).catch((e) =>
        console.warn("[MonacoEditor] save failed:", e),
      );
    });

    onReady?.({
      revealLine: (line, column) => {
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column });
        ed.focus();
      },
    });
  };

  // Apply diagnostics markers to the active model whenever they change.
  useEffect(() => {
    const monaco = monacoRef.current;
    const ed = editorRef.current;
    if (monaco === null || ed === null) return;
    const model = ed.getModel();
    if (model === null) return;
    monaco.editor.setModelMarkers(model, MODEL_OWNER, toMonacoMarkers(diagnostics));
  }, [diagnostics]);

  const handleChange = (value: string | undefined): void => {
    const next = value ?? "";
    onChange(next);
    pushToBackend(tab.id, next);
  };

  return (
    <div className="editor-pane">
      <Editor
        /* `path` keys the underlying model by tab id, so each tab keeps its
         * own undo history and view state across tab switches. */
        path={`inmemory://typst-studio/${tab.id}`}
        language="typst"
        theme="typst-light"
        value={tab.content}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        loading="Loading editor…"
        options={{
          fontSize: 13,
          fontFamily:
            '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
          fontLigatures: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: "on",
          renderWhitespace: "selection",
        }}
      />
    </div>
  );
}
