import { useEffect, useState } from "react";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type { TextContents } from "monaco-languageclient/editorApp";
import type { LanguageClientManager } from "monaco-languageclient/lcwrapper";
import { updateText } from "../../lib/tauri";
import type { Tab } from "../../store/tabsStore";
import { useDebouncedCallback } from "../../hooks/useDebounce";
import {
  buildVscodeApiConfig,
  buildLanguageClientConfig,
  buildEditorAppConfig,
  getLspWsUrl,
} from "./lspClient";

/** Imperative surface exposed to the parent for navigation (diagnostics goto). */
export interface MonacoEditorApi {
  revealLine: (line: number, column: number) => void;
}

interface MonacoEditorProps {
  tab: Tab;
  onChange: (value: string) => void;
  onReady?: (api: MonacoEditorApi) => void;
}

const vscodeApiConfig = buildVscodeApiConfig();

export function MonacoEditor({ tab, onChange, onReady }: MonacoEditorProps) {
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [lspReady, setLspReady] = useState(false);

  // Fetch the LSP WebSocket URL on mount.
  useEffect(() => {
    let cancelled = false;
    getLspWsUrl().then((url) => {
      if (!cancelled) {
        setWsUrl(url);
        setLspReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced backend push for the compile pipeline (SVG preview).
  const pushToBackend = useDebouncedCallback((id: string, value: string) => {
    void updateText(id, value).catch((e) =>
      console.warn("[MonacoEditor] updateText failed:", e),
    );
  }, 100);

  const languageClientConfig = wsUrl
    ? buildLanguageClientConfig(wsUrl)
    : undefined;

  const editorAppConfig = buildEditorAppConfig(tab.id, tab.content);

  const handleTextChanged = (textChanges: TextContents): void => {
    const next = textChanges.modified ?? "";
    onChange(next);
    pushToBackend(tab.id, next);
  };

  const handleLanguageClientsStartDone = (
    _lcsManager: LanguageClientManager,
  ): void => {
    onReady?.({
      revealLine: (_line, _column) => {
        // TODO: implement revealLine with the new editor API
      },
    });
  };

  const handleError = (error: Error): void => {
    console.error("[MonacoEditor] error:", error);
  };

  // Don't render until we've checked LSP availability.
  if (!lspReady) {
    return <div className="editor-pane">Loading editor...</div>;
  }

  return (
    <div className="editor-pane">
      <MonacoEditorReactComp
        vscodeApiConfig={vscodeApiConfig}
        editorAppConfig={editorAppConfig}
        languageClientConfig={languageClientConfig}
        style={{ height: "100%" }}
        onTextChanged={handleTextChanged}
        onLanguageClientsStartDone={handleLanguageClientsStartDone}
        onError={handleError}
        enforceLanguageClientDispose={true}
      />
    </div>
  );
}
