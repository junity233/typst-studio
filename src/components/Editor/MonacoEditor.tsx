import { useEffect, useMemo } from "react";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type { TextContents } from "monaco-languageclient/editorApp";
import type { LanguageClientManager } from "monaco-languageclient/lcwrapper";
import { updateText } from "../../lib/tauri";
import type { Tab } from "../../store/tabsStore";
import { useDebouncedCallback } from "../../hooks/useDebounce";
import { useLspStatus } from "../../store/lspStore";
import {
  buildVscodeApiConfig,
  buildLanguageClientConfig,
  buildEditorAppConfig,
  registerTypstMemFile,
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
  // Single source of truth for LSP status across the app (shared with
  // StatusBar). Seeds from get_lsp_status, then subscribes to events.
  const { status: lspStatus, loading: lspLoading } = useLspStatus();
  // The editor needs the wsUrl to build its language client config. We treat
  // "ready" as: the initial status fetch resolved (wsUrl may still be empty if
  // tinymist is unavailable — in that case the editor renders without LSP).
  const wsUrl = lspStatus.wsUrl || null;

  // Debounced backend push for the compile pipeline (SVG preview).
  const pushToBackend = useDebouncedCallback((id: string, value: string) => {
    void updateText(id, value).catch((e) =>
      console.warn("[MonacoEditor] updateText failed:", e),
    );
  }, 100);

  // Memoize the language-client config on `wsUrl` so it keeps a stable identity
  // across re-renders. The React wrapper's config effect re-runs on every new
  // object reference; before the client is started that would push duplicate
  // `lcInit` entries onto an un-deduped queue, risking concurrent handshakes.
  const languageClientConfig = useMemo(
    () => (wsUrl ? buildLanguageClientConfig(wsUrl) : undefined),
    [wsUrl],
  );

  // Recovery on WebSocket drop: monaco-languageclient's `restartOptions` path
  // is dead code (the onClose handler stops the client before restart runs),
  // so a dropped connection permanently kills the language client. We recover
  // by remounting the whole editor when `wsUrl` changes — a new `key` forces
  // a full unmount+mount, which disposes the dead client and runs a fresh
  // `initialize`. The backend spawns a brand-new tinymist per connection, so
  // this is a legal handshake rather than a protocol-violating repeat.
  //
  // DESIGN TRADEOFF (documented): the key includes `tab.id`, so switching
  // tabs remounts the editor → reconnects → the backend supersedes and kills
  // the prior tinymist. This costs a tinymist cold-start per tab switch and
  // discards server-side state (incremental parse, open-document set). The
  // lower-cost alternative — sharing one client across tabs by swapping only
  // the Monaco model via `updateCodeResources` (didOpen/didClose on the same
  // session) — was considered but NOT adopted: the `@typefox/monaco-editor-react`
  // wrapper's didClose-on-model-swap behavior could not be statically verified
  // against the compiled bundle, and an incorrect document-sync lifecycle
  // would cause subtler bugs than the current cold-start cost. Revisit when
  // multi-tab LSP is a measured problem; the fix is to decouple editor render
  // from language-client lifetime (drive the `lcsManager` singleton directly).
  const editorKey = `lsp-${wsUrl ?? "nolsp"}-tab-${tab.id}`;

  // Pure config builder; memoized so re-renders don't churn the editor.
  // Note: only `tab.id` (not `content`) is a dependency — once mounted, the
  // Monaco model is the source of truth and edits flow via onTextChanged.
  const editorAppConfig = useMemo(
    () => buildEditorAppConfig(tab.id, tab.content),
    [tab.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Register the tab's in-memory file exactly once per tab, and unregister
  // on cleanup so the VSCode file service never holds stale/duplicate URIs.
  useEffect(() => {
    const unregister = registerTypstMemFile(tab.id, tab.content);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

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

  // Don't render until the initial LSP status fetch resolves — we need to know
  // whether tinymist is available before deciding to wire up a language client.
  if (lspLoading) {
    return <div className="editor-pane">Loading editor...</div>;
  }

  return (
    <div className="editor-pane">
      <MonacoEditorReactComp
        key={editorKey}
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
