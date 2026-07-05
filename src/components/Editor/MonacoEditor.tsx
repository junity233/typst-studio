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
  detectOriginTransition,
  migrateModelForSaveAs,
  originSignature,
} from "./saveAsMigration";
import {
  applyWrapSelection,
  applyReplaceSelection,
  applyToggleLinePrefix,
  getSelectionText,
} from "./editorEdit";
import { registerTypstHighlighting } from "./typstHighlighting";
import { usePasteConvert } from "./usePasteConvert";
import type { DocumentOrigin } from "../../lib/types";

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
  /** Return the currently-selected text (empty string for a collapsed caret or
   *  no selection). Used by the toolbar's link flow (spec §5.3) to use the
   *  selection as the link label / fall back to a bare link. */
  getSelectionText: () => string;
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
  //
  // CRITICAL — frozen after first definition: the wrapper
  // (@typefox/monaco-editor-react) has TWO effects that both call
  // `performGlobalInit` (one keyed on editorAppConfig, one on
  // languageClientConfig). If languageClientConfig transitions from
  // `undefined` to a defined object AFTER mount (e.g. wsUrl resolving null→
  // value), the second effect re-runs `performGlobalInit`, and a race with
  // the first effect's async `apiWrapper.start()` double-initializes Monaco's
  // services → "Services are already initialized" panic. We freeze the first
  // non-undefined value into a ref so the prop is stable for the wrapper's
  // lifetime; wsUrl changes after mount do NOT reconfigure the wrapper's
  // client (recovery is AppLanguageClient's job in Phase B).
  const liveLanguageClientConfig = useMemo(
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
  const frozenLanguageClientConfigRef = useRef(liveLanguageClientConfig);
  if (
    frozenLanguageClientConfigRef.current === undefined &&
    liveLanguageClientConfig !== undefined
  ) {
    frozenLanguageClientConfigRef.current = liveLanguageClientConfig;
  }
  const languageClientConfig = frozenLanguageClientConfigRef.current;

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
  // CRITICAL — frozen after first render. The wrapper has an effect keyed on
  // `editorAppConfig` that calls `performGlobalInit`; a new object identity
  // here (every settings change) re-triggers it and races the languageClient-
  // Config effect's init, double-initializing Monaco services. Settings are
  // applied LIVE to the editor via `editor.updateOptions(...)` (see the
  // settings-options effect below), so the wrapper's prop only needs to carry
  // the initial options. Freeze the first computed value and never update it.
  const frozenEditorAppConfigRef = useRef<EditorAppConfig | undefined>(
    undefined,
  );
  if (frozenEditorAppConfigRef.current === undefined) {
    frozenEditorAppConfigRef.current = editorAppConfig;
  }
  const frozenEditorAppConfig = frozenEditorAppConfigRef.current;

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

  // The previous origin for each open document id, used by the Save-As
  // origin-transition effect (§11) to detect which docs' origins changed since
  // the last render and drive a model migration for exactly those. Comparison
  // goes through `originSignature` (via `detectOriginTransition`) so a re-
  // render that produces a structurally-equal origin (e.g. a content edit that
  // rebuilds the documents map) does NOT look like a transition. Populated
  // lazily as docs are first observed; cleared on close.
  const prevOriginsRef = useRef<Map<string, DocumentOrigin>>(new Map());

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
  // Structural key of EVERY open doc's origin signature, joined by NUL in id
  // order. This is what the Save-As origin-transition effect (§11) subscribes
  // to: a Save As changes exactly one doc's `origin` (path), which changes its
  // signature, which changes this key, which re-runs the effect. Content-only
  // edits do NOT change origins, so the key is stable across keystrokes (the
  // store rebuilds `documents` on every edit, but every signature is unchanged,
  // so the joined key is byte-identical — no spurious re-runs).
  const originsKey = useDocumentsStore((s) =>
    Object.entries(s.documents)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, d]) => `${id}\u0000${originSignature(d.origin)}`)
      .join("\u0000"),
  );
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

  // Save-As origin-transition effect (spec §11, Task 9). When a Save As (or a
  // rename) succeeds, `documentsStore.markSaved` / `rebindDocPath` transitions
  // the doc's `origin` to the new disk location. Monaco model URIs are
  // immutable, so a transition requires a model REPLACEMENT (the registry's
  // `migrateUri`: atomic URI-map swap + new model at the new URI + dispose old).
  // This effect is the SINGLE place that drives that migration: it diffs each
  // open doc's previous origin signature against its current one and, for each
  // doc that actually transitioned, calls `migrateModelForSaveAs`.
  //
  // Active vs non-active: the editor swap + selection/viewState restore is only
  // correct for the ACTIVE doc (only it is attached to the editor). For a
  // non-active doc — e.g. Save All on a background tab, or a programmatic save
  // — we pass NO editor, so the orchestration does a REGISTRY-ONLY migration
  // (the model is replaced; the editor swap happens later, via the normal
  // `activate` path, if/when the doc becomes active). This is also why there
  // is exactly ONE migration call site: passing the editor only for the active
  // id means the registry migration runs once per transitioned doc regardless
  // of active-ness, and the editor swap runs at most once (for the active id).
  // No double-migration.
  //
  // Failure path: a Save As that fails does NOT call `markSaved`, so the doc's
  // origin does NOT change, so `originsKey` does NOT change, so this effect
  // does NOT re-run — the old model is left untouched (§11: "Save As 失败时不
  // 触碰旧 model").
  //
  // PERF / re-run discipline: subscribe to `originsKey` (a structural string),
  // NOT to `s.documents` — the store rebuilds the top-level object on every
  // keystroke, which would re-run this effect on every edit. The full docs map
  // is read via `getState()` inside the effect (an escape hatch that doesn't
  // subscribe). `tab.id` is a dependency because the active-id decides which
  // transitioned doc gets the editor swap.
  //
  // §12.1 RENAME BATCH MIGRATION (Task 10 Part A): the file-tree rename flow
  // reuses this SAME effect — no separate rename code path exists. The chain is:
  //   backend `rename_entry` → `DocumentService::rebind_for_rename` (rebinds
  //     every open doc under the renamed path — single FILE rename ⇒ 1 doc;
  //     DIRECTORY rename ⇒ N open sub-docs) → emits `docs_rebound` carrying one
  //     entry per rebound doc
  //   → `useTypstCompile`'s `onDocsRebound` handler calls `rebindDocPath` for
  //     each entry, which updates `origin` (NEW object: new `path`, same variant
  //     + workspace_id/root), `path`, and `title` without touching dirty /
  //     content / revision (the buffer survives the rename)
  //   → the renamed doc's `originSignature` differs, so `originsKey` changes, so
  //     this effect re-runs. The per-doc loop then migrates EACH renamed doc:
  //     `detectOriginTransition` returns the new origin for every doc the rebind
  //     touched (and null for untouched docs), so a DIRECTORY rename producing
  //     N `docs_rebound` entries ⇒ N origin transitions ⇒ N `migrateModelForSaveAs`
  //     calls ⇒ N registry URI migrations (old-URI model disposed → didClose(old)
  //     fires implicitly; new-URI model created → didOpen(new) fires implicitly).
  //     Zustand batches the synchronous rebinds into ONE render, so `originsKey`
  //     re-derives once with ALL N renamed docs present, and the loop migrates
  //     them in a single pass. Pinned by renameBatchMigration.test.ts.
  //
  // The §12.1 "session/recovery/breadcrumb/diagnostics sync" requirements are
  // satisfied for FREE by the existing wiring (no extra code):
  //   - Diagnostics: the bridge routes via `monacoModelRegistry.resolveDocumentId`,
  //     which returns null for the OLD (post-migration removed) uri — so in-flight
  //     tinymist diagnostics keyed on the stale uri are dropped automatically
  //     (lspDiagnosticsBridge.ts). The new-URI model picks up fresh diagnostics.
  //   - Breadcrumb: `Breadcrumb.tsx` reads `useActiveDocument()` →
  //     `documentsStore.documents[id].path`, which `rebindDocPath` updated, so the
  //     breadcrumb + dirty indicator follow the rename with no extra plumbing.
  //   - Session/recovery: the backend already rebound the doc's canonical path
  //     in `rebind_for_rename` (registry/world/VFS/watcher all moved), so the
  //     next recovery snapshot / session capture writes the NEW path.
  useEffect(() => {
    const documents = useDocumentsStore.getState().documents;
    const activeId = tab.id;
    const editor = getEditor();
    const prev = prevOriginsRef.current;
    const next = new Map<string, DocumentOrigin>();

    for (const [id, doc] of Object.entries(documents)) {
      next.set(id, doc.origin);
      const prevOrigin = prev.get(id);
      if (prevOrigin === undefined) {
        // First time we observe this id: no transition to migrate. (The
        // model-sync effect opened it; we just record its baseline origin.)
        continue;
      }
      // `detectOriginTransition` is the named contract for "did the origin
      // actually change" — it compares via `originSignature`, so a structurally-
      // equal origin (e.g. a content edit that rebuilt the documents map) is
      // NOT a transition. Returns the new origin when it changed, null else.
      const transition = detectOriginTransition(prevOrigin, doc.origin);
      if (transition === null) continue;
      // Origin transitioned. Drive the Save-As model replacement. Pass the
      // editor ONLY for the active doc (only it is attached to the editor);
      // non-active docs get a registry-only migration whose editor swap runs
      // later, via the normal `activate` path, if/when the doc becomes active.
      migrateModelForSaveAs(
        id,
        transition,
        id === activeId ? editor : null,
      );
    }

    prevOriginsRef.current = next;
  }, [originsKey, tab.id, getEditor]);

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
      getSelectionText: () => {
        const editor = getEditor();
        if (!editor) return "";
        return getSelectionText(editor);
      },
    });
  };

  const handleError = (error: Error): void => {
    console.error("[MonacoEditor] error:", error);
  };

  // Don't render the wrapper until LSP status has STABILIZED, so the frozen
  // languageClientConfig (below) captures its final value at first mount. The
  // wrapper's two effects (editorAppConfig-keyed + languageClientConfig-keyed)
  // both call performGlobalInit; if languageClientConfig transitions undefined
  // → defined after mount, the second effect re-runs init and races the first
  // → "Services are already initialized" panic. By waiting until the LSP
  // status is stable (available⇒wsUrl non-empty, OR confirmed !available),
  // the first mount sees the final languageClientConfig and the freeze keeps
  // it (and editorAppConfig) stable for the wrapper's lifetime.
  const lspReady =
    !lspLoading && (lspStatus.available ? wsUrl !== null : true);
  if (!lspReady) {
    return <div className="editor-pane">Loading editor...</div>;
  }

  return (
    <div className="editor-pane">
      <MonacoEditorReactComp
        // NO React `key`: the wrapper (@typefox/monaco-editor-react) initializes
        // Monaco's VS Code services exactly once per process via
        // MonacoVscodeApiWrapper.start(). A `key` change forces unmount+remount,
        // and the wrapper re-runs start() on the new mount — panicking with
        // "Services are already initialized" because MonacoVscodeApiWrapper's
        // constructor resets the `vscodeApiInitialising` guard (a version-skew
        // bug between monaco-editor-react@7.7 and monaco-languageclient). So
        // the editor must mount exactly once for the whole app lifetime.
        //
        // Consequence: a wsUrl change (LSP restart / WebSocket drop) does NOT
        // remount, so the language client won't auto-recover via remount. The
        // wrapper's own restart path is dead code anyway (its onClose handler
        // stops the client before restart runs, and setConfig is a no-op once
        // a languageId is registered). Real recovery is the AppLanguageClient
        // singleton's job (Task 4 / Phase B) — when that takes over the live
        // session, this wrapper is removed entirely. For Phase A we accept
        // "no auto-recovery on WS drop" in exchange for not panicking at boot.
        vscodeApiConfig={vscodeApiConfig}
        editorAppConfig={frozenEditorAppConfig}
        languageClientConfig={languageClientConfig}
        style={{ height: "100%" }}
        onTextChanged={handleTextChanged}
        onEditorStartDone={handleEditorStartDone}
        onLanguageClientsStartDone={handleLanguageClientsStartDone}
        onError={handleError}
        // Keep the client alive across tab switches. The shared `lcsManager`
        // singleton must NOT be disposed on every model swap.
        enforceLanguageClientDispose={false}
      />
    </div>
  );
}
