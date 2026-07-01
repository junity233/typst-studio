import { useEffect, useMemo, useRef, useState } from "react";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type { TextContents } from "monaco-languageclient/editorApp";
import type { LanguageClientManager } from "monaco-languageclient/lcwrapper";
import { updateText } from "../../lib/tauri";
import type { Tab } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
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

  // The workspace root, used to root tinymist's World so completion resolves
  // #include / @preview against the real project. Null when no folder is open.
  // Read via a ref so a workspace-open does NOT churn the mounted editor —
  // tinymist's rootPath is fixed at `initialize` and can't change mid-session
  // anyway, and re-creating the config mid-mount destabilizes the language
  // client (the wrapper reacts to a new config object by tearing the client
  // down, which races the backend's single-connection relay). The value is
  // captured fresh whenever the editor naturally (re)mounts (initial load, a
  // tab switch, a wsUrl recovery) — which is exactly when rootPath can take
  // effect.
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;

  // Debounced backend push for the compile pipeline (SVG preview).
  const pushToBackend = useDebouncedCallback((id: string, value: string) => {
    void updateText(id, value).catch((e) =>
      console.warn("[MonacoEditor] updateText failed:", e),
    );
  }, 100);

  // Memoize the language-client config on `wsUrl` ONLY (not rootPath). A
  // workspace-open must not rebuild the config for a mounted editor — that
  // would restart the client and race the relay (see rootPathRef note). The
  // fresh rootPath is picked up on the next natural mount.
  const languageClientConfig = useMemo(
    () => (wsUrl ? buildLanguageClientConfig(wsUrl, rootPathRef.current) : undefined),
    [wsUrl],
  );

  // The editor instance + tinymist client are SHARED across tabs: the `key`
  // does NOT include `tab.id`, so switching tabs does NOT remount the editor.
  // `lcsManager` (the language-client manager) is a module-level singleton in
  // @typefox/monaco-editor-react, so the tinymist session survives tab
  // switches — no cold-start, no lost incremental-parse state.
  //
  // Recovery on WebSocket drop: monaco-languageclient's `restartOptions` path
  // is dead code (the onClose handler stops the client before restart runs),
  // so a dropped connection permanently kills the language client. We recover
  // by remounting only when `wsUrl` changes — a new `key` forces a full
  // unmount+mount, which disposes the dead client and runs a fresh
  // `initialize`. The backend spawns a brand-new tinymist per connection, so
  // this is a legal handshake rather than a protocol-violating repeat.
  const editorKey = `lsp-${wsUrl ?? "nolsp"}`;

  // The editor-app config is rebuilt per tab so the model URI differs per tab.
  // Changing the URI (vs only the text) is what routes through
  // `triggerReprocessConfig` → `updateCodeResources` → `editor.setModel`,
  // which fires automatic didClose(old) + didOpen(new) on the SAME tinymist
  // session (verified in the installed @typefox/monaco-editor-react bundle).
  const editorAppConfig = useMemo(
    () => buildEditorAppConfig(tab.id, tab.content),
    [tab.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The current tab id, via a ref. CRITICAL: the editor instance is shared
  // across tabs, so `handleTextChanged` (registered once at mount) must read
  // the LIVE tab id — not the id captured when the callback was created.
  // Without this, edits on tab B would be pushed to the backend under tab A.
  const tabIdRef = useRef(tab.id);
  tabIdRef.current = tab.id;
  // Ditto for onChange — it closes over the parent's active tab; keep it live.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Register the tab's in-memory file before bumping the reprocess counter.
  // The new model URI must resolve (file must be registered) BEFORE
  // `updateCodeResources` looks it up, so registration runs in an effect that
  // fires before the reprocess bump below. The file is unregistered when the
  // tab leaves (cleanup) so the VSCode file service never holds stale URIs.
  useEffect(() => {
    const unregister = registerTypstMemFile(tab.id, tab.content);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Drive the model swap: bumping `triggerReprocessConfig` makes
  // MonacoEditorReactComp call `updateCodeResources` (compares the URI in
  // editorAppConfig to the live model's URI; on change → setModel). A bump on
  // every tab.id change is what performs the swap + automatic didOpen/didClose.
  // We skip the very first run (mount) — the editor mounts with this tab's
  // model already; bumping then would be a redundant swap to the same URI.
  const [reprocessTick, setReprocessTick] = useState(0);
  const skipFirstSwap = useRef(true);
  useEffect(() => {
    if (skipFirstSwap.current) {
      skipFirstSwap.current = false;
      return;
    }
    setReprocessTick((t) => t + 1);
  }, [tab.id]);

  const handleTextChanged = (textChanges: TextContents): void => {
    const next = textChanges.modified ?? "";
    onChangeRef.current(next);
    pushToBackend(tabIdRef.current, next);
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
        triggerReprocessConfig={reprocessTick}
        style={{ height: "100%" }}
        onTextChanged={handleTextChanged}
        onLanguageClientsStartDone={handleLanguageClientsStartDone}
        onError={handleError}
        // Keep the client alive across tab switches. The shared `lcsManager`
        // singleton must NOT be disposed on every model swap; only a wsUrl-keyed
        // remount (recovery) tears it down, which this `false` allows.
        enforceLanguageClientDispose={false}
      />
    </div>
  );
}
