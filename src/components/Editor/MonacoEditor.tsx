import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Monaco from "@codingame/monaco-vscode-editor-api";
import { getService, IWorkbenchThemeService } from "@codingame/monaco-vscode-api/services";
import type { TextContents, EditorAppConfig } from "monaco-languageclient/editorApp";
import { updateText } from "../../lib/tauri";
import type { Tab } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useDebouncedCallback } from "../../hooks/useDebounce";
import { useLspStatus } from "../../store/lspStore";
import { useSetting } from "../../hooks/useSetting";
import {
  ensureVscodeApiInitialized,
} from "./lspClient";
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
  applyStrReplace,
  applyToggleLinePrefix,
  applyToggleWrap,
  isInsideWrap as isInsideWrapHelper,
  isLinePrefixActive as isLinePrefixActiveHelper,
  getSelectionText,
  getSelectedLines as getSelectedLinesHelper,
} from "./editorEdit";
import { shouldDisableOccurrencesHighlight } from "./editorOptions";
import { registerTypstHighlighting, applyTypstTokenTheme } from "./typstHighlighting";
import { useThemeStore } from "../../store/themeStore";
import { usePasteConvert } from "./usePasteConvert";
import type { DocumentOrigin } from "../../lib/types";
import { DirectMonacoEditor } from "./DirectMonacoEditor";
import { appLanguageClient } from "./appLanguageClient";

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
  /** Maximum valid vertical scroll offset in px. */
  getMaxScrollTop: () => number;
  /** Current caret line (1-indexed). Used by preview line-marking. */
  getCurrentLine: () => number;
  /** Current selection's covered source lines; empty when the caret is collapsed. */
  getSelectedLines: () => number[];
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
  /**
   * Replace the unique first occurrence of `oldString` with `newString` in the
   * active model. Used by the AI assistant's `edit` tool. Returns false (and
   * applies nothing) when `oldString` is absent or non-unique; the caller is
   * responsible for supplying more context to disambiguate. Single undo step.
   */
  strReplace: (oldString: string, newString: string) => boolean;
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
  /** Idempotent wrap toggle: unwrap if the selection (or caret surroundings) is
   *  already wrapped in `prefix…suffix`, else wrap. Single-line caret scan.
   *  Used by the bold/italic/strikethrough/code/quote buttons so clicking bold
   *  on `*foo*` removes the bold instead of double-wrapping. */
  toggleWrap: (prefix: string, suffix: string, placeholder?: string) => void;
  /** Does the current selection/caret sit inside a `prefix…suffix` region on its
   *  line? Used by the toolbar to set the wrap buttons' `aria-pressed` state. */
  isInsideWrap: (prefix: string, suffix: string) => boolean;
  /** Does the caret/selection's first line start with `prefix`? Used by the
   *  toolbar to set the heading/list buttons' `aria-pressed` state. */
  isLinePrefixActive: (prefix: string) => boolean;
  /** Subscribe to editor cursor-position or selection changes. The callback
   *  receives no args (the toolbar re-queries `isInsideWrap`/`isLinePrefixActive`
   *  on each fire). Returns an unsubscribe function. Mirrors `onDidScrollChange`. */
  onDidChangeCursorPosition: (cb: () => void) => () => void;
  /**
   * Format the active document via Monaco's built-in
   * `editor.action.formatDocument` action. That action routes to tinymist's
   * `textDocument/formatting` (auto-registered by vscode-languageclient's
   * `DocumentFormattingEditProviderFeature`); the returned `TextEdit[]` is
   * applied by Monaco's own machinery, and the content-change flows through the
   * existing `handleTextChanged → updateText` backend sync — so no Rust change
   * is needed for the formatting itself. Returns `false` when there is no
   * editor or the action isn't registered (e.g. tinymist unavailable); the
   * caller decides how to surface that.
   */
  formatDocument: () => Promise<boolean>;
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

function parseRgbChannel(input: string): number | null {
  const value = Number.parseInt(input.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function inferBaseFromCss(): "light" | "dark" | null {
  if (typeof window === "undefined") return null;
  const canvas = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--color-canvas")
    .trim();
  let r: number | null = null;
  let g: number | null = null;
  let b: number | null = null;
  const rgbMatch = /^rgb\(\s*([0-9]+),\s*([0-9]+),\s*([0-9]+)\s*\)$/i.exec(canvas);
  if (rgbMatch) {
    r = parseRgbChannel(rgbMatch[1]);
    g = parseRgbChannel(rgbMatch[2]);
    b = parseRgbChannel(rgbMatch[3]);
  } else {
    const hexMatch = /^#([0-9a-f]{6})$/i.exec(canvas);
    if (hexMatch) {
      r = Number.parseInt(hexMatch[1].slice(0, 2), 16);
      g = Number.parseInt(hexMatch[1].slice(2, 4), 16);
      b = Number.parseInt(hexMatch[1].slice(4, 6), 16);
    }
  }
  if (r === null || g === null || b === null) return null;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

interface MonacoEditorProps {
  tab: Tab;
  onChange: (value: string) => void;
  onReady?: (api: MonacoEditorApi) => void;
}

export function MonacoEditor({ tab, onChange, onReady }: MonacoEditorProps) {
  const { t } = useTranslation("editor");
  // Pre-initialize the monaco-vscode-api services ONCE before the wrapper
  // component mounts, so the wrapper's performGlobalInit takes its
  // "already initialised" branch and never news/races a second wrapper. See
  // `ensureVscodeApiInitialized` for the root-cause writeup.
  const [vscodeApiReady, setVscodeApiReady] = useState(false);
  const [vscodeApiInitError, setVscodeApiInitError] = useState<string | null>(
    null,
  );
  const [typstHighlightingReady, setTypstHighlightingReady] = useState(false);
  const [editorRuntimeReady, setEditorRuntimeReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureVscodeApiInitialized()
      .then(() => {
        if (!cancelled) {
          setVscodeApiReady(true);
          setVscodeApiInitError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setVscodeApiInitError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // `editor.updateDebounceMs` drives the compile-push debouncer below. Read
  // here (before `pushToBackend`) so it is in scope; the value is also a normal
  // settings option consumed via the options memo further down.
  const [updateDebounceMs] = useSetting<number>("editor.updateDebounceMs");

  // Debounced backend push for the compile pipeline (SVG preview). The window
  // is the `editor.updateDebounceMs` setting; rebuilding on its change is
  // intended (useDebouncedCallback keys its stable callback on `delay`).
  const pushToBackend = useDebouncedCallback((
    id: string,
    value: string,
    revision: number,
  ) => {
    void updateText(id, value, revision).catch((e) =>
      console.warn("[MonacoEditor] updateText failed:", e),
    );
  }, updateDebounceMs ?? 100);

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
  // Editor + preview settings (reactive). Each `useSetting` re-renders this
  // component when its value changes, which flows new options into the memo
  // below — the wrapper live-applies them via `editor.updateOptions`.
  const [fontSize] = useSetting<number>("editor.fontSize");
  const [fontFamily] = useSetting<string>("editor.fontFamily");
  const [tabSize] = useSetting<number>("editor.tabSize");
  const [wordWrap] = useSetting<boolean>("editor.wordWrap");
  const [lineNumbers] = useSetting<boolean>("editor.lineNumbers");
  const [minimap] = useSetting<boolean>("editor.minimap");
  const [fontLigatures] = useSetting<boolean>("editor.fontLigatures");
  const [themeId] = useSetting<string>("appearance.theme");
  const [renderWhitespace] = useSetting<
    "none" | "all" | "boundary" | "selection" | "trailing"
  >("editor.renderWhitespace");
  const [folding] = useSetting<boolean>("editor.folding");
  const [scrollBeyondLastLine] = useSetting<boolean>(
    "editor.scrollBeyondLastLine",
  );
  const [lineHeight] = useSetting<number>("editor.lineHeight");
  // Preview visibility still controls the initial replay compile below, but
  // ordinary buffer synchronization is unconditional: saves and recovery need
  // the backend to own the latest text even while the preview is hidden.
  const previewVisible = useUiStore((s) => s.previewVisible);

  // Read through a ref so the initial replay sees the live visibility value.
  const previewVisibleRef = useRef(previewVisible);
  previewVisibleRef.current = previewVisible;

  // The "highlight all occurrences of the word under the cursor" feature
  // (wordHighlighter) resolves the current
  // model via the workbench's TextModelResolverService on every cursor move,
  // which can READ the model's resource through VS Code's browser FileService.
  // Typst Studio's real document bytes live in the backend and Monaco model
  // registry, not in that FileService overlay, so disable this feature for
  // Typst models to avoid noisy "Unable to read file" promise rejections.
  const activeOriginKind = useDocumentsStore(
    (s) => s.documents[tab.id]?.origin.kind ?? "untitled",
  );

  const themes = useThemeStore((s) => s.themes);
  const currentBase = useThemeStore((s) => s.currentBase);
  const [resolvedBase, setResolvedBase] = useState<"light" | "dark">(() => {
    const inferred = inferBaseFromCss();
    return inferred ?? currentBase;
  });
  useEffect(() => {
    const resolvedThemeId = themeId && themeId.length > 0 ? themeId : "default";
    const matchedTheme =
      resolvedThemeId === "default"
        ? undefined
        : themes.find((theme) => theme.id === resolvedThemeId);
    const nextBase =
      matchedTheme?.base === "dark"
        ? "dark"
        : matchedTheme?.base === "light"
          ? "light"
          : inferBaseFromCss() ?? currentBase;
    setResolvedBase(nextBase);
  }, [themeId, themes, currentBase]);
  const isDark = resolvedBase === "dark";
  const monacoTheme = isDark ? "vs-dark" : "vs";

  // Settings-derived editor options. Only keys that are actually set are
  // overridden; everything else falls through to the built-in defaults below.
  // `editor.fontFamily` is applied only when non-empty so an unset value keeps
  // Monaco's own font stack. `editor.lineHeight` of 0 means "Monaco default",
  // so we omit it in that case rather than force 0.
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
      if (fontLigatures !== undefined) opts.fontLigatures = fontLigatures;
      if (renderWhitespace !== undefined) opts.renderWhitespace = renderWhitespace;
      if (folding !== undefined) opts.folding = folding;
      if (scrollBeyondLastLine !== undefined)
        opts.scrollBeyondLastLine = scrollBeyondLastLine;
      if (lineHeight !== undefined && lineHeight > 0) opts.lineHeight = lineHeight;
      if (shouldDisableOccurrencesHighlight(activeOriginKind)) {
        opts.occurrencesHighlight = "off";
      }
      return opts;
    }, [
      fontSize,
      fontFamily,
      tabSize,
      wordWrap,
      lineNumbers,
      minimap,
      fontLigatures,
      renderWhitespace,
      folding,
      scrollBeyondLastLine,
      lineHeight,
      activeOriginKind,
    ]);

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
        fontSize: 14,
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
        // Seed Monaco with the correct chrome theme at creation time so dark
        // UI themes never flash or stick on the light standalone palette.
        theme: monacoTheme,
        // Tighten the vertical air around the text so the editor reads edge-to-edge
        // within its pane instead of floating in wide whitespace.
        padding: { top: 6, bottom: 6 },
        ...settingsOptions,
      },
    }),
    [settingsOptions, monacoTheme],
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
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const getEditor = useCallback<
    () => Monaco.editor.IStandaloneCodeEditor | null
  >(() => editorRef.current, []);

  // Register Typst syntax highlighting (TextMate grammar + theme CSS).
  // Runs once on mount, before the editor creates its model. The actual
  // WASM/grammar/theme loading is lazy (via TokenizationRegistry.registerFactory)
  // so it doesn't block editor creation — the model starts in plain-text mode
  // and re-tokenizes with colors once initialization completes.
  useEffect(() => {
    if (!vscodeApiReady) return;
    let cancelled = false;
    void registerTypstHighlighting()
      .then(() => {
        if (!cancelled) setTypstHighlightingReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setVscodeApiInitError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vscodeApiReady]);

  // Apply settings-derived options directly to the live Monaco instance. The
  // wrapper's processConfig is no longer in the model-swap path (Phase A: no
  // triggerReprocessConfig), so we keep options live-applied here, touching
  // ONLY options — never content (the registry owns the model text).
  useEffect(() => {
    getEditor()?.updateOptions(settingsOptions);
  }, [settingsOptions, getEditor]);

  // Drive the editor's theme from the active UI theme's `base`. Two layers move
  // together: (1) Monaco's chrome theme (`vs` light / `vs-dark` dark) via
  // `updateOptions`, and (2) the TextMate token palette (Light+ / Dark+) via
  // `applyTypstTokenTheme`, which rewrites the `.mtk{i}` CSS. `currentBase`
  // comes from the theme store and is resolved in `useTheme` from the current
  // theme's `ThemeInfo.base`.
  useEffect(() => {
    if (!vscodeApiReady || !editorRuntimeReady) return;
    const workbenchTheme = isDark ? "Default Dark Modern" : "Default Light Modern";
    let cancelled = false;
    const applyMonacoTheme = () => {
      Monaco.editor.setTheme(monacoTheme);
      getEditor()?.updateOptions({ theme: monacoTheme });
    };
    applyMonacoTheme();
    void getService(IWorkbenchThemeService)
      .then((themeService) => themeService.setColorTheme(workbenchTheme, "auto"))
      .then(() => {
        if (!cancelled) {
          applyMonacoTheme();
        }
      })
      .catch((error) => {
        console.warn("[MonacoEditor] workbench theme sync failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [isDark, monacoTheme, vscodeApiReady, editorRuntimeReady, getEditor]);

  useEffect(() => {
    if (!typstHighlightingReady) return;
    void applyTypstTokenTheme(isDark ? "dark" : "light");
  }, [isDark, typstHighlightingReady]);

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
    // createModel reaches StandaloneServices.get(). If it runs while the VS
    // Code API is still starting, Monaco permanently initializes its singleton
    // with the fallback services and ignores the real overrides added later.
    if (!vscodeApiReady || !typstHighlightingReady) return;

    const documents = useDocumentsStore.getState().documents;
    const plan = computeModelSyncPlan(
      seenIdsRef.current,
      documents,
      tab.id,
      prevTabId,
    );

    // 1. Close gone docs FIRST (§10.4). closeModel disposes the model; the
    //    CALLER (a future task) is responsible for the LSP didClose
    //    notification. Closing before opening matters when a single store
    //    update drops an old id and adds a new id for the SAME path: closing
    //    the old id first disposes its model (freeing that URI in Monaco's
    //    ModelService) before the open touches the same URI. (openModel itself
    //    is URI-aware and resilient to a collision, but ordering the close
    //    first removes the divergence at its source.)
    for (const id of plan.toClose) {
      monacoModelRegistry.closeModel(id);
      seenIdsRef.current.delete(id);
    }

    // 2. Open newly-appeared docs (§10.1). openModel is idempotent per id;
    //    the plan only lists ids absent from seenIdsRef, so each is opened once.
    for (const entry of plan.toOpen) {
      monacoModelRegistry.openModel(entry.id, {
        content: entry.content,
        origin: entry.origin,
        revision: entry.revision,
      });
      seenIdsRef.current.add(entry.id);
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
  }, [
    openDocsKey,
    tab.id,
    prevTabId,
    getEditor,
    vscodeApiReady,
    typstHighlightingReady,
  ]);

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
    if (!vscodeApiReady || !typstHighlightingReady) return;

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
  }, [
    originsKey,
    tab.id,
    getEditor,
    vscodeApiReady,
    typstHighlightingReady,
  ]);

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
    const id = tabIdRef.current;
    onChangeRef.current(next);
    // Zustand mutations are synchronous. Read the revision AFTER updateContent
    // so the version attached to this snapshot is the exact Monaco content
    // version, even when debounce coalesces many keystrokes into one IPC.
    const revision =
      useDocumentsStore.getState().documents[id]?.revision;
    // Buffer synchronization is authoritative document state, so it must not
    // depend on whether the preview is visible or auto-refresh is enabled.
    // Preview settings only control reconciliation/rendering downstream.
    if (revision !== undefined) {
      pushToBackend(id, next, revision);
    }
  };

  const handleEditorStartDone = (
    editor: Monaco.editor.IStandaloneCodeEditor,
  ): void => {
    editorRef.current = editor;
    editor.updateOptions(settingsOptions);
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
    const model = editor.getModel();
    // Initial backend compilation can finish before the frontend's event
    // listeners are attached (especially on session restore). Replay the
    // current text once when the preview is empty so it always gets a fresh
    // compiled event. The backend treats unchanged text as a recompile rather
    // than an edit, so this does not mark the document dirty or bump revision.
    if (
      doc &&
      doc.svgPages.length === 0 &&
      previewVisibleRef.current &&
      model !== null
    ) {
      void updateText(doc.id, model.getValue(), doc.revision).catch((error) =>
        console.warn("[MonacoEditor] initial preview compile failed:", error),
      );
    }
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
      getMaxScrollTop: () => {
        const editor = getEditor();
        if (!editor) return 0;
        return Math.max(
          0,
          editor.getScrollHeight() - editor.getLayoutInfo().height,
        );
      },
      getCurrentLine: () => {
        const editor = getEditor();
        return editor?.getPosition()?.lineNumber ?? 1;
      },
      getSelectedLines: () => {
        const editor = getEditor();
        return editor ? getSelectedLinesHelper(editor) : [];
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
        const d = editor.onDidScrollChange((event) => {
          // Horizontal scrolling uses this event too, but must not claim
          // scroll-sync ownership. Vertical movement and scroll-height changes
          // (font size, wrapping, folding, content reflow) both require a fresh
          // editor-derived target.
          if (event.scrollTopChanged || event.scrollHeightChanged) cb(topLine());
        });
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
      strReplace: (oldString, newString) => {
        const editor = getEditor();
        if (!editor) return false;
        return applyStrReplace(editor, oldString, newString);
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
      // Format-toolbar state-aware seam (Task 2): idempotent toggle + queries
      // mirror the wrapSelection/replaceSelection/toggleLinePrefix/​getSelection
      // edit seam above — same getEditor() gating, same thin-dispatcher shape.
      toggleWrap: (prefix, suffix, placeholder) => {
        const editor = getEditor();
        if (!editor) return;
        applyToggleWrap(editor, prefix, suffix, placeholder);
      },
      isInsideWrap: (prefix, suffix) => {
        const editor = getEditor();
        if (!editor) return false;
        return isInsideWrapHelper(editor, prefix, suffix);
      },
      isLinePrefixActive: (prefix) => {
        const editor = getEditor();
        if (!editor) return false;
        return isLinePrefixActiveHelper(editor, prefix);
      },
      // Subscription mirroring `onDidScrollChange` above. Fire on BOTH cursor-
      // position changes (caret moves: clicks, arrow keys) and selection changes
      // (drag/select) so the toolbar's aria-pressed state tracks both.
      onDidChangeCursorPosition: (cb) => {
        const editor = getEditor();
        if (!editor) return () => {};
        const d1 = editor.onDidChangeCursorPosition(() => cb());
        const d2 = editor.onDidChangeCursorSelection(() => cb());
        return () => {
          d1.dispose();
          d2.dispose();
        };
      },
      // Format seam (Task: Format Document): invokes Monaco's built-in
      // `editor.action.formatDocument`, which the LSP client wires to tinymist's
      // `textDocument/formatting`. Same `getEditor()` gating + thin-dispatcher
      // shape as the wrapSelection/replaceSelection edit seam above.
      formatDocument: async () => {
        const editor = getEditor();
        if (!editor) return false;
        const action = editor.getAction("editor.action.formatDocument");
        if (!action) return false;
        await action.run();
        return true;
      },
    });
    setEditorRuntimeReady(true);
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
  //
  // STICKY MOUNT: the gate defers the FIRST mount only. Once the wrapper has
  // mounted, we keep it mounted across transient `lspReady` false-flips (an
  // LSP restart republishing an intermediate `lsp_status` with `available:
  // false` / empty wsUrl). Unmounting DirectMonacoEditor on every reconnect
  // is destructive: the singleton monacoModelRegistry (and Monaco's own
  // ModelService) outlive the unmount, so a remount racing a fresh backend
  // document id can trip Monaco's "Cannot add model because it already
  // exists!" assertion. LSP recovery is driven by the appLanguageClient.start
  // effect below and useLspWorkspaceReconnect — neither needs the editor to
  // remount.
  const lspReady =
    !lspLoading && (lspStatus.available ? wsUrl !== null : true);
  const editorGate =
    lspReady && vscodeApiReady && typstHighlightingReady;
  const [editorMountedOnce, setEditorMountedOnce] = useState(false);
  useEffect(() => {
    if (editorGate && !editorMountedOnce) {
      setEditorMountedOnce(true);
    }
  }, [editorGate, editorMountedOnce]);
  useEffect(() => {
    if (!editorRuntimeReady) return;
    if (!lspReady) return;
    if (wsUrl === null) return;
    void appLanguageClient
      .start({
        wsUrl,
        workspaceRootPath: rootPathRef.current,
        workspaceName: workspaceNameRef.current,
      })
      .catch((error) => {
        console.warn("[MonacoEditor] appLanguageClient.start failed:", error);
      });
  }, [editorRuntimeReady, lspReady, wsUrl]);

  if (vscodeApiInitError !== null) {
    return (
      <div className="editor-pane">
        {t("initFailed", { message: vscodeApiInitError })}
      </div>
    );
  }

  // Show the loading placeholder only BEFORE the first successful mount. Once
  // mounted, stay mounted (sticky) even if the gate transiently fails.
  if (!editorMountedOnce && !editorGate) {
    return <div className="editor-pane">{t("loading")}</div>;
  }

  return (
    <div className="editor-pane">
      <DirectMonacoEditor
        editorOptions={frozenEditorAppConfig?.editorOptions}
        style={{ height: "100%" }}
        onTextChanged={handleTextChanged}
        onEditorStartDone={handleEditorStartDone}
        onError={handleError}
      />
    </div>
  );
}
