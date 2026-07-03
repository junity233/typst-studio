import { useEffect, useMemo, useRef, useState } from "react";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { TextContents, EditorApp } from "monaco-languageclient/editorApp";
import type { LanguageClientManager } from "monaco-languageclient/lcwrapper";
import { StandaloneServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import { IMarkerService } from "@codingame/monaco-vscode-api/vscode/vs/platform/markers/common/markers.service";
import { MarkerSeverity, type IMarkerData } from "@codingame/monaco-vscode-api/vscode/vs/platform/markers/common/markers";
import { Uri } from "vscode";
import { updateText } from "../../lib/tauri";
import type { Tab } from "../../store/tabsStore";
import type { Diagnostic } from "../../lib/types";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useDebouncedCallback } from "../../hooks/useDebounce";
import { useLspStatus } from "../../store/lspStore";
import { useSetting } from "../../hooks/useSetting";
import {
  buildVscodeApiConfig,
  buildLanguageClientConfig,
  buildEditorAppConfig,
  registerTypstMemFile,
  MEM_ROOT,
} from "./lspClient";
import { usePasteConvert } from "./usePasteConvert";

/**
 * Imperative surface exposed to the parent for navigation (diagnostics goto,
 * preview click-to-source) and scroll-sync.
 */
export interface MonacoEditorApi {
  /** Reveal a line, place the cursor, and focus (diagnostics / click-to-source). */
  revealLine: (line: number, column: number) => void;
  /**
   * Reveal a line at the top of the viewport only if it's currently outside the
   * visible range; otherwise no-op. Used by preview→editor scroll-sync so the
   * editor follows smoothly without re-centering (and jittering) on every tick.
   */
  revealLineTopIfOutsideViewport: (line: number) => void;
  /** The topmost fully/partially visible source line (1-indexed). */
  getTopVisibleLine: () => number;
  /** Current scroll offset in px (for interpolated scroll-sync). */
  getScrollTop: () => number;
  /** Set the scroll offset in px (for interpolated scroll-sync). */
  setScrollTop: (top: number) => void;
  /**
   * Pixel offset of a line from the top of the scrollable content (for
   * interpolated scroll-sync mapping source-line → editor pixel position).
   */
  getLineTopOffset: (line: number) => number;
  /**
   * Subscribe to editor scroll changes; the callback receives the new top
   * visible line. Returns an unsubscribe function.
   */
  onDidScrollChange: (cb: (topLine: number) => void) => () => void;
}

/**
 * `Monaco.editor.ScrollType.Immediate` (= 1). The reveal APIs default to
 * `Smooth`, which — if a user ever enables `editor.smoothScrolling` — animates
 * over 125ms and fires `onDidScrollChange` on every frame, escaping our
 * scroll-sync guard (tuned for the immediate case). Passing `Immediate` makes
 * the feedback loop robust by construction regardless of that setting. Used as
 * a literal because `Monaco` is imported as a type-only namespace.
 */
const SCROLL_IMMEDIATE = 1;

interface MonacoEditorProps {
  tab: Tab;
  onChange: (value: string) => void;
  onReady?: (api: MonacoEditorApi) => void;
}

const vscodeApiConfig = buildVscodeApiConfig();

/**
 * Map a Monaco `MarkerSeverity` bitmask (Error=8, Warning=4, Info=2, Hint=1)
 * → the app's Diagnostic severity union.
 */
function markerSeverity(s: MarkerSeverity): Diagnostic["severity"] {
  if ((s & MarkerSeverity.Error) === MarkerSeverity.Error) return "Error";
  if ((s & MarkerSeverity.Warning) === MarkerSeverity.Warning) return "Warning";
  if ((s & MarkerSeverity.Info) === MarkerSeverity.Info) return "Info";
  return "Info";
}

/**
 * Extract the tab id from a `file:///typst-studio-mem/<id>.typ` URI string, or
 * null if the URI isn't one of our in-memory tab URIs.
 */
function tabIdFromUri(uriStr: string): string | null {
  let path: string;
  try {
    path = Uri.parse(uriStr).path;
  } catch {
    return null;
  }
  const prefix = `${MEM_ROOT}/`;
  if (!path.startsWith(prefix)) return null;
  const file = path.slice(prefix.length);
  if (!file.endsWith(".typ")) return null;
  return file.slice(0, -".typ".length);
}

// One-shot bridge from Monaco's marker service into the per-tab diagnostics
// store. Installed after services are up; idempotent. The marker service holds
// the authoritative diagnostics (the language client's diagnostics feature
// pushes `publishDiagnostics` there AND renders squiggles from it), so we read
// markers — never subscribe to publishDiagnostics (that would clobber the
// feature handler and silence the squiggles).
let diagBridgeInstalled = false;
function ensureDiagBridge(): void {
  if (diagBridgeInstalled) return;
  diagBridgeInstalled = true;
  const markers = StandaloneServices.get(IMarkerService);

  const sync = (uris: readonly { toString(): string }[]): void => {
    for (const u of uris) {
      const id = tabIdFromUri(u.toString());
      if (id === null) continue;
      const data: IMarkerData[] = markers.read({
        resource: Uri.parse(u.toString()),
      }) as unknown as IMarkerData[];
      const diags: Diagnostic[] = data.map((m) => ({
        severity: markerSeverity(m.severity),
        message: m.message ?? "",
        code: null,
        range: {
          start_line: m.startLineNumber,
          start_column: m.startColumn,
          end_line: m.endLineNumber,
          end_column: m.endColumn,
        },
      }));
      useDiagnosticsStore.getState().set(id, diags);
    }
  };

  markers.onMarkerChanged((uris) => sync(uris));
}

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

  // Editor + preview settings (reactive). Each `useSetting` re-renders this
  // component when its value changes, which flows new options into the memo
  // below — the wrapper live-applies them via `editor.updateOptions`.
  const [fontSize] = useSetting<number>("editor.fontSize");
  const [fontFamily] = useSetting<string>("editor.fontFamily");
  const [tabSize] = useSetting<number>("editor.tabSize");
  const [wordWrap] = useSetting<boolean>("editor.wordWrap");
  const [lineNumbers] = useSetting<boolean>("editor.lineNumbers");
  const [minimap] = useSetting<boolean>("editor.minimap");
  const [autoRefresh] = useSetting<boolean>("preview.autoRefresh");
  // When the preview pane is hidden there's no point compiling; the gate is
  // OR'd with `preview.autoRefresh` below. Read via the store directly (not a
  // prop) so a toggle re-renders EditorArea — not this editor — yet the
  // debounced push callback still sees the live value through `previewVisibleRef`.
  const previewVisible = useUiStore((s) => s.previewVisible);

  // `preview.autoRefresh` AND preview visibility gate the compile-pipeline push.
  // Read through refs so the (once-created) debounced callback always sees the
  // live values without being rebuilt on every toggle.
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;
  const previewVisibleRef = useRef(previewVisible);
  previewVisibleRef.current = previewVisible;

  // Settings-derived editor options. Only keys that are actually set are
  // overridden; everything else falls through to buildEditorAppConfig's
  // built-in defaults. `editor.fontFamily` is applied only when non-empty so
  // an unset value keeps Monaco's own font stack.
  const settingsOptions =
    useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(() => {
      const opts: Monaco.editor.IStandaloneEditorConstructionOptions = {};
      if (fontSize !== undefined) opts.fontSize = fontSize;
      if (fontFamily && fontFamily.length > 0) opts.fontFamily = fontFamily;
      if (tabSize !== undefined) {
        opts.tabSize = tabSize;
        opts.insertSpaces = true;
      }
      if (wordWrap !== undefined) opts.wordWrap = wordWrap ? "on" : "off";
      if (lineNumbers !== undefined)
        opts.lineNumbers = lineNumbers ? "on" : "off";
      if (minimap !== undefined) opts.minimap = { enabled: minimap };
      return opts;
    }, [fontSize, fontFamily, tabSize, wordWrap, lineNumbers, minimap]);

  // The editor-app config is rebuilt per tab so the model URI differs per tab.
  // Changing the URI (vs only the text) is what routes through
  // `triggerReprocessConfig` → `updateCodeResources` → `editor.setModel`,
  // which fires automatic didClose(old) + didOpen(new) on the SAME tinymist
  // session (verified in the installed @typefox/monaco-editor-react bundle).
  //
  // The config is ALSO rebuilt when `settingsOptions` changes so the wrapper
  // live-applies new editor options. To keep that rebuild from re-pushing the
  // live document text through `updateCode` (which would churn the mounted
  // editor — cursor/undo disruption), the `codeResources` text is pinned to
  // the seed captured at tab switch via `seedContentRef`. Live edits flow
  // through the model, never the config.
  const seedContentRef = useRef(tab.content);
  const seededTabIdRef = useRef(tab.id);
  if (seededTabIdRef.current !== tab.id) {
    seededTabIdRef.current = tab.id;
    seedContentRef.current = tab.content;
  }
  const editorAppConfig = useMemo(
    () => buildEditorAppConfig(tab.id, seedContentRef.current, settingsOptions),
    [tab.id, settingsOptions], // eslint-disable-line react-hooks/exhaustive-deps
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
  // The paste-convert hook needs the FULL tab (for `tab.path` to resolve
  // image-write directories), not just the id. Kept live on every render so
  // the (once-registered) capture-phase listener always sees the current tab.
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;

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

  // Apply settings-derived options directly to the live Monaco instance. We
  // deliberately bypass the wrapper's processConfig (which only runs on a
  // reprocess bump): processConfig text-diffs the config's codeResources —
  // pinned to the tab-switch seed — against the live model, and would call
  // `updateCode` with that stale seed, clobbering unsaved edits. Calling
  // `editor.updateOptions` touches ONLY options, never content.
  const editorAppRef = useRef<EditorApp | null>(null);
  useEffect(() => {
    editorAppRef.current?.getEditor()?.updateOptions(settingsOptions);
  }, [settingsOptions]);

  // Rich-text paste: capture-phase listener converts pasted HTML to Typst and
  // resolves/inserts images. Wired through `getEditor` (closes over
  // `editorAppRef`) + `tabRef` (live tab) so the hook sees fresh values
  // without re-registering the listener on every keystroke.
  const getEditor: () => Monaco.editor.IStandaloneCodeEditor | null = () =>
    editorAppRef.current?.getEditor() ?? null;
  usePasteConvert(getEditor, tabRef);

  const handleTextChanged = (textChanges: TextContents): void => {
    const next = textChanges.modified ?? "";
    // Always keep the local tab content current so a manual refresh can push
    // it; only gate the backend compile push on `preview.autoRefresh`.
    onChangeRef.current(next);
    if (autoRefreshRef.current !== false && previewVisibleRef.current) {
      pushToBackend(tabIdRef.current, next);
    }
  };

  const handleEditorStartDone = (editorApp?: EditorApp): void => {
    editorAppRef.current = editorApp ?? null;
    editorApp?.getEditor()?.updateOptions(settingsOptions);
  };

  const handleLanguageClientsStartDone = (
    _lcsManager: LanguageClientManager,
  ): void => {
    // The language client's built-in diagnostics feature already routes
    // `publishDiagnostics` into Monaco's marker service (which renders the
    // squiggles). We do NOT subscribe to publishDiagnostics directly — that
    // would clobber the feature handler and kill the squiggles. Instead, once
    // services are up, we read the marker service for every in-memory tab and
    // mirror markers into the per-tab diagnosticsStore (which the panel reads).
    ensureDiagBridge();

    onReady?.({
      revealLine: (line, column) => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        if (!editor) return;
        // Reveal the line (centered when far from the viewport, top-aligned
        // when nearby) and move the cursor + focus so the user can type on.
        // Immediate scroll keeps the preview-sync guard robust.
        editor.revealLineInCenterIfOutsideViewport(line, SCROLL_IMMEDIATE);
        editor.setPosition({ lineNumber: line, column });
        editor.focus();
      },
      revealLineTopIfOutsideViewport: (line) => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        if (!editor) return;
        // Only scroll when the line has scrolled out of view, and align it to
        // the top (not center) so repeated small scrolls produce a smooth,
        // linear follow instead of the re-center jitter from `InCenter`.
        editor.revealLineInCenterIfOutsideViewport(line, SCROLL_IMMEDIATE);
      },
      getTopVisibleLine: () => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        const ranges = editor?.getVisibleRanges() ?? [];
        // The first visible range is the topmost line in the viewport.
        return ranges.length > 0 ? ranges[0].startLineNumber : 1;
      },
      getScrollTop: () => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        return editor ? editor.getScrollTop() : 0;
      },
      setScrollTop: (top) => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        editor?.setScrollTop(top);
      },
      getLineTopOffset: (line) => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        return editor ? editor.getTopForLineNumber(line) : 0;
      },
      onDidScrollChange: (cb) => {
        const editor = editorAppRef.current?.getEditor() ?? null;
        if (!editor) return () => {};
        // `onDidScrollChange` fires on any viewport change (scroll, layout,
        // fold). We re-derive the top visible line and forward it.
        const topLine = () => {
          const ranges = editor.getVisibleRanges();
          return ranges.length > 0 ? ranges[0].startLineNumber : 1;
        };
        const d = editor.onDidScrollChange(() => cb(topLine()));
        return () => d.dispose();
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
        onEditorStartDone={handleEditorStartDone}
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
