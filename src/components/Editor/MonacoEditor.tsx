import { useCallback, useEffect, useMemo, useRef } from "react";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type {
  TextContents,
  EditorApp,
  EditorAppConfig,
} from "monaco-languageclient/editorApp";
import type { LanguageClientManager } from "monaco-languageclient/lcwrapper";
import { updateText } from "../../lib/tauri";
import type { Tab } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useDebouncedCallback } from "../../hooks/useDebounce";
import { useLspStatus } from "../../store/lspStore";
import { useSetting } from "../../hooks/useSetting";
import { buildVscodeApiConfig, buildLanguageClientConfig } from "./lspClient";
import { monacoModelRegistry } from "./monacoModelRegistry";
import { installLspDiagnosticsBridge } from "./lspDiagnosticsBridge";
import { computeModelSyncPlan } from "./editorModelSync";
import {
  applyWrapSelection,
  applyReplaceSelection,
  applyToggleLinePrefix,
} from "./editorEdit";
import { registerTypstHighlighting } from "./typstHighlighting";
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
  /** Wrap the current selection (or insert placeholder if empty) with
   *  prefix/suffix. Used for `*…*`, `_…_`, `` `…` ``, etc. Selects the
   *  placeholder range when there was no selection so the user can type. */
  wrapSelection: (prefix: string, suffix: string, placeholder?: string) => void;
  /** Replace the current selection with `text`, then select the inserted
   *  range. Used for snippets where we don't wrap (code block, HR, image,
   *  table produce a block to drop in). */
  replaceSelection: (text: string) => void;
  /** Toggle a line-prefix marker (e.g. `= ` for H1, `- ` for bullet, `+ ` for
   *  numbered). Operates on every line touched by the selection (or the
   *  caret's line if no selection). If the prefix already exists on a line it
   *  is removed; otherwise it is added. Also strips a *different* known prefix
   *  before adding the new one, so toggling H1 → H2 replaces rather than stacks. */
  toggleLinePrefix: (prefix: string) => void;
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

export function MonacoEditor({ tab, onChange, onReady }: MonacoEditorProps) {
  // Single source of truth for LSP status across the app (shared with
  // StatusBar). Seeds from get_lsp_status, then subscribes to events.
  const { status: lspStatus, loading: lspLoading } = useLspStatus();
  // The editor needs the wsUrl to build its language client config. We treat
  // "ready" as: the initial status fetch resolved (wsUrl may still be empty if
  // tinymist is unavailable — in that case the editor renders without LSP).
  const wsUrl = lspStatus.wsUrl || null;

  // The workspace root + name, used to root tinymist's World via
  // `clientOptions.workspaceFolder` (§7.1) so completion resolves #include /
  // @preview against the real project. Null when no folder is open (§7.2). Read
  // via refs so a workspace-open does NOT churn the mounted editor — tinymist's
  // root is fixed at `initialize` and can't change mid-session anyway, and
  // re-creating the config mid-mount destabilizes the language client (the
  // wrapper reacts to a new config object by tearing the client down, which
  // races the backend's single-connection relay). The value is captured fresh
  // whenever the editor naturally (re)mounts (initial load, a wsUrl recovery)
  // — which is exactly when the workspace folder can take effect.
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const workspaceName = useWorkspaceStore((s) => s.name);
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  const workspaceNameRef = useRef(workspaceName);
  workspaceNameRef.current = workspaceName;

  // Debounced backend push for the compile pipeline (SVG preview).
  const pushToBackend = useDebouncedCallback((id: string, value: string) => {
    void updateText(id, value).catch((e) =>
      console.warn("[MonacoEditor] updateText failed:", e),
    );
  }, 100);

  // Memoize the language-client config on `wsUrl` ONLY (not workspace). A
  // workspace-open must not rebuild the config for a mounted editor — that
  // would restart the client and race the relay (see rootPathRef note). The
  // fresh workspace folder is picked up on the next natural mount.
  const languageClientConfig = useMemo(
    () =>
      wsUrl
        ? buildLanguageClientConfig(
            wsUrl,
            rootPathRef.current,
            workspaceNameRef.current,
          )
        : undefined,
    [wsUrl],
  );

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
  // overridden; everything else falls through to the built-in defaults below.
  // `editor.fontFamily` is applied only when non-empty so an unset value keeps
  // Monaco's own font stack.
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

  // Phase A (spec §8.3 / §10.5): models are owned by `monacoModelRegistry`,
  // NOT by the wrapper's `editorAppConfig` URI. The wrapper still needs an
  // `editorAppConfig`, but the model is now driven by the registry: the wrapper
  // mounts with its throwaway default model (no `codeResources` provided), and
  // `handleEditorStartDone` immediately calls `activate` to swap in the real
  // registry model. Tab switches thereafter are pure `editor.setModel` via
  // `activate` — NO remount, NO `didClose`/`didOpen` (§10.5).
  const editorAppConfig = useMemo<EditorAppConfig>(
    () => ({
      // Editor options only — no `codeResources`. The registry owns the model.
      editorOptions: {
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
        // Reclaim editable width: drop the glyph margin and slim the line-number
        // gutter. Typst needs neither breakpoints nor a wide number column.
        glyphMargin: false,
        lineNumbersMinChars: 3,
        folding: false,
        // Disable CodeLens: tinymist publishes a "1@Export PDF" clickable lens at
        // the top of the document. The app exposes export through the native menu
        // instead, so hide the lens.
        codeLens: false,
        // Tighten the vertical air around the text so the editor reads edge-to-edge
        // within its pane instead of floating in wide whitespace.
        padding: { top: 6, bottom: 6 },
        ...settingsOptions,
      },
    }),
    [settingsOptions],
  );

  // The current tab id, via a ref. CRITICAL: the editor instance is shared
  // across tabs, so `handleTextChanged` (registered once at mount) must read
  // the LIVE tab id — not the id captured when the callback was created.
  // Without this, edits on tab B would be pushed to the backend under tab A.
  const tabIdRef = useRef(tab.id);
  tabIdRef.current = tab.id;
  // The PREVIOUS tab id — the outgoing view on a tab switch (§10.5). Read into
  // `prevTabId` synchronously during render BEFORE advancing the ref, so the
  // model-sync effect below sees the real (prevActiveId → activeId) transition
  // on the render where the switch happens, and no-op on subsequent re-renders
  // with the same active id.
  const prevTabIdRef = useRef<string | null>(null);
  const prevTabId = prevTabIdRef.current;
  prevTabIdRef.current = tab.id;
  // Ditto for onChange — it closes over the parent's active tab; keep it live.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The paste-convert hook needs the FULL tab (for `tab.path` to resolve
  // image-write directories), not just the id. Kept live on every render so
  // the (once-registered) capture-phase listener always sees the current tab.
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;

  // The set of document ids the editor has already opened in the registry.
  // Used by the model-sync effect to open each id exactly once and to close
  // ids that disappeared from the documents map (§10.1 / §10.4). Maintained
  // across renders as a ref so the effect can diff against the prior snapshot.
  const seenIdsRef = useRef<Set<string>>(new Set());

  // The live editor instance (set in `handleEditorStartDone`). Used by the
  // model-sync effect to activate models and restore view state. Memoized so
  // it's a stable reference for effect/use-hook dependencies (otherwise an
  // inline closure would retrigger the model-sync effect every render).
  const editorAppRef = useRef<EditorApp | null>(null);
  const getEditor = useCallback<
    () => Monaco.editor.IStandaloneCodeEditor | null
  >(() => editorAppRef.current?.getEditor() ?? null, []);

  // Register Typst syntax highlighting (TextMate grammar + theme CSS).
  // Runs once on mount, before the editor creates its model. The actual
  // WASM/grammar/theme loading is lazy (via TokenizationRegistry.registerFactory)
  // so it doesn't block editor creation — the model starts in plain-text mode
  // and re-tokenizes with colors once initialization completes.
  useEffect(() => {
    void registerTypstHighlighting();
  }, []);

  // Apply settings-derived options directly to the live Monaco instance. The
  // wrapper's processConfig is no longer in the model-swap path (Phase A: no
  // triggerReprocessConfig), so we keep options live-applied here, touching
  // ONLY options — never content (the registry owns the model text).
  useEffect(() => {
    getEditor()?.updateOptions(settingsOptions);
  }, [settingsOptions, getEditor]);

  // The model-sync effect (spec §8.3 / §10.1 / §10.4 / §10.5): on every render
  // where the SET of open documents OR the active tab changes, compute a plan
  // via the pure [`computeModelSyncPlan`](./editorModelSync.ts) helper and
  // dispatch it against the registry. Keeps the component a thin dispatcher
  // around the (untestable-under-jsdom) registry/editor.
  //
  // Runs AFTER the editor has started (the activate half is gated on a live
  // editor). Open/close are registry-only and safe to run before the editor
  // mounts (they create/dispose models, not editor attachments).
  //
  // PERF: subscribe to a structural key (sorted id list joined by NUL) rather
  // than the whole `documents` map. The store rebuilds the top-level object on
  // every keystroke (`updateContent`), so subscribing to `s.documents` would
  // re-run this effect on every edit — wasteful, since content edits don't
  // change which models are open. The full docs map is read via `getState()`
  // inside the effect (an escape hatch that doesn't subscribe). `tab.id` /
  // `prevTabId` are stable across content-only re-renders, so `toActivate`
  // fires exactly once per switch.
  const openDocsKey = useDocumentsStore((s) => Object.keys(s.documents).sort().join("\0"));
  useEffect(() => {
    const documents = useDocumentsStore.getState().documents;
    const plan = computeModelSyncPlan(
      seenIdsRef.current,
      documents,
      tab.id,
      prevTabId,
    );

    // 1. Open newly-appeared docs (§10.1). openModel is idempotent per id;
    //    the plan only lists ids absent from seenIdsRef, so each is opened once.
    for (const entry of plan.toOpen) {
      monacoModelRegistry.openModel(entry.id, {
        content: entry.content,
        origin: entry.origin,
        revision: entry.revision,
      });
      seenIdsRef.current.add(entry.id);
    }

    // 2. Close gone docs (§10.4). closeModel disposes the model; the CALLER
    //    (a future task) is responsible for the LSP didClose notification.
    for (const id of plan.toClose) {
      monacoModelRegistry.closeModel(id);
      seenIdsRef.current.delete(id);
    }

    // 3. Activate the active tab's model in the editor (§10.5): swap the
    //    editor's model + restore its view state. Gated on the editor being
    //    live — on the very first mount the editor starts AFTER this effect's
    //    initial run, so the first activation happens in handleEditorStartDone
    //    (which is itself self-sufficient: see the open-if-absent guard there).
    if (plan.toActivate !== null) {
      const editor = getEditor();
      if (editor !== null) {
        const result = monacoModelRegistry.activate(
          plan.toActivate,
          editor,
          prevTabId,
        );
        if (result.viewState !== null) {
          editor.restoreViewState(result.viewState);
        }
      }
    }
  }, [openDocsKey, tab.id, prevTabId, getEditor]);

  // Rich-text paste: capture-phase listener converts pasted HTML to Typst and
  // resolves/inserts images. Wired through `getEditor` (closes over
  // `editorAppRef`) + `tabRef` (live tab) so the hook sees fresh values
  // without re-registering the listener on every keystroke.
  usePasteConvert(getEditor, tabRef);

  const handleTextChanged = (textChanges: TextContents): void => {
    const next = textChanges.modified ?? "";
    // Anti-bounce-back (§8.4): when the registry itself replaces model text on
    // behalf of a backend disk-reload (controlled replace), the resulting
    // content-change fires here. Skip the forward to the backend in that case
    // — the backend is the source of that change, and re-forwarding would loop.
    if (monacoModelRegistry.isSuppressingForward(tabIdRef.current)) return;
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
    // The wrapper mounted with a throwaway default model (no codeResources);
    // swap in the active tab's real registry model now. This is the §10.5
    // "setModel" half for the very first tab — subsequent tab switches are
    // handled by the model-sync effect above.
    //
    // SELF-SUFFICIENT OPEN: the model-sync effect normally opens the active
    // doc's model before the editor starts, but that ordering relies on the
    // wrapper's async init deferral — NOT a React guarantee. If the wrapper
    // ever fired this callback synchronously (or on a wsUrl-remount where the
    // apiWrapper was already initialized), the model might not be open yet
    // and `activate` would throw on an unknown id. Open idempotently here so
    // this callback is correct regardless of when it fires relative to the
    // effect.
    const editor = getEditor();
    if (editor !== null) {
      const doc = useDocumentsStore.getState().documents[tab.id];
      if (doc && !monacoModelRegistry.getModel(tab.id)) {
        monacoModelRegistry.openModel(tab.id, {
          content: doc.content,
          origin: doc.origin,
          revision: doc.revision,
        });
        seenIdsRef.current.add(tab.id);
      }
      const result = monacoModelRegistry.activate(tab.id, editor, null);
      if (result.viewState !== null) {
        editor.restoreViewState(result.viewState);
      }
    }
  };

  const handleLanguageClientsStartDone = (
    _lcsManager: LanguageClientManager,
  ): void => {
    // The language client's built-in diagnostics feature already routes
    // `publishDiagnostics` into Monaco's marker service (which renders the
    // squiggles). The bridge (spec §13.2 / §17) reads the marker service and
    // mirrors markers into the per-document diagnosticsStore's `tinymist` slot
    // (which the panel reads). It is generation-aware: on an LSP restart it
    // clears stale tinymist diagnostics from the dead session. Idempotent.
    installLspDiagnosticsBridge();

    onReady?.({
      revealLine: (line, column) => {
        const editor = getEditor();
        if (!editor) return;
        // Reveal the line (centered when far from the viewport, top-aligned
        // when nearby) and move the cursor + focus so the user can type on.
        // Immediate scroll keeps the preview-sync guard robust.
        editor.revealLineInCenterIfOutsideViewport(line, SCROLL_IMMEDIATE);
        editor.setPosition({ lineNumber: line, column });
        editor.focus();
      },
      revealLineTopIfOutsideViewport: (line) => {
        const editor = getEditor();
        if (!editor) return;
        // Only scroll when the line has scrolled out of view, and align it to
        // the top (not center) so repeated small scrolls produce a smooth,
        // linear follow instead of the re-center jitter from `InCenter`.
        editor.revealLineInCenterIfOutsideViewport(line, SCROLL_IMMEDIATE);
      },
      getTopVisibleLine: () => {
        const editor = getEditor();
        const ranges = editor?.getVisibleRanges() ?? [];
        // The first visible range is the topmost line in the viewport.
        return ranges.length > 0 ? ranges[0].startLineNumber : 1;
      },
      getScrollTop: () => {
        const editor = getEditor();
        return editor ? editor.getScrollTop() : 0;
      },
      setScrollTop: (top) => {
        const editor = getEditor();
        editor?.setScrollTop(top);
      },
      getLineTopOffset: (line) => {
        const editor = getEditor();
        return editor ? editor.getTopForLineNumber(line) : 0;
      },
      onDidScrollChange: (cb) => {
        const editor = getEditor();
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
      // Format-toolbar edit seam (Task 1): the actual edit logic lives in pure
      // helpers (`editorEdit.ts`) that are unit-tested directly; the component
      // is just a thin dispatcher gated on `getEditor()`, mirroring the
      // revealLine methods above.
      wrapSelection: (prefix, suffix, placeholder) => {
        const editor = getEditor();
        if (!editor) return;
        applyWrapSelection(editor, prefix, suffix, placeholder);
      },
      replaceSelection: (text) => {
        const editor = getEditor();
        if (!editor) return;
        applyReplaceSelection(editor, text);
      },
      toggleLinePrefix: (prefix) => {
        const editor = getEditor();
        if (!editor) return;
        applyToggleLinePrefix(editor, prefix);
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
        // Phase A interim (spec §17 移除 list): the `key` is wsUrl-ONLY — it
        // does NOT include `tab.id`, so a tab switch does NOT remount the
        // editor (the whole point of §10.5: tab switch = setModel, no remount).
        // The wsUrl `key` is retained because the wrapper's
        // LanguageClientManager.setConfig is a no-op when the languageId already
        // exists, and start() is gated on !isStarted() — so a wsUrl change
        // while MOUNTED does NOT restart the client, and a dropped WebSocket
        // permanently kills the client (monaco-languageclient's restart path is
        // dead code: the onClose handler stops the client before restart runs).
        // The only recovery is a full unmount+mount, which this `key` drives.
        // Task 4 (Phase B) lifts the LanguageClient out of this component into
        // AppLanguageClient; once that owns the lifecycle, this `key` can go.
        key={`lsp-${wsUrl ?? "nolsp"}`}
        vscodeApiConfig={vscodeApiConfig}
        editorAppConfig={editorAppConfig}
        languageClientConfig={languageClientConfig}
        style={{ height: "100%" }}
        onTextChanged={handleTextChanged}
        onEditorStartDone={handleEditorStartDone}
        onLanguageClientsStartDone={handleLanguageClientsStartDone}
        onError={handleError}
        // Keep the client alive across tab switches (now even more important
        // since we're not remounting on tab change). The shared `lcsManager`
        // singleton must NOT be disposed on every model swap; only a wsUrl-keyed
        // remount (recovery) tears it down, which this `false` allows.
        enforceLanguageClientDispose={false}
      />
    </div>
  );
}
