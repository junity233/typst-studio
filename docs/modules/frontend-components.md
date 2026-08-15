# Frontend — components

> Scope: `src/components/**` except Shell/TitleBar/StatusBar (see
> [frontend-shell.md](frontend-shell.md)).

The component layer renders every feature surface: the Monaco editor with
its tinymist language client, the preview panes, the sidebar panels,
settings, and the dialog family. It is deliberately thin: components read
zustand stores and call typed wrappers in `src/lib/tauri.ts` — never
`invoke` directly.

## Editor (`src/components/Editor/`)

- `MonacoEditor.tsx` — the editor host: one-time monaco-vscode-api init,
  settings-derived options (live via `editor.updateOptions`), model sync,
  Save-As / rename origin-transition migrations, per-doc debounced
  `update_text` pushes, initial-compile replay, and a ~25-method
  `MonacoEditorApi` exposed via `onReady`.
- `appLanguageClient.ts` — module-level singleton; the app's ONLY tinymist
  client. Builds `MonacoLanguageClient` over a WebSocket, serializes
  start/stop through one promise chain, drops stale wsUrl generations,
  45 s init timeout, `startWithFreshEndpoint` reconnect.
- `monacoModelRegistry.ts` — module singleton owning every Monaco model for
  the app's lifetime; tab switches are `editor.setModel`, never remounts.
- `editorModelSync.ts` — pure planner `{toClose,toOpen,toActivate}` from
  documents/tab diffs (jsdom-testable).
- `typstHighlighting.ts` — direct TextMate registration of the `typst`
  grammar + token themes, bypassing the extension host.
- `lspDiagnosticsBridge.ts` — routes tinymist `publishDiagnostics` into
  `diagnosticsStore` (slot `tinymist`).
- `usePasteConvert.ts` — capture-phase paste: HTML→Typst via
  `lib/htmlToTypst`; clipboard/remote/data-URI images written to disk and
  inserted as `#image("…")`; Cmd/Ctrl+Shift+V pastes raw.
- `workspaceApplyEditHandler.ts` — overrides LSP `workspace/applyEdit`:
  open-doc edits → live models; closed files → backend
  `apply_text_edits_to_disk_file`.
- `saveAsMigration.ts` — `originSignature` / `migrateModelForSaveAs`
  (atomic URI-map swap; shared by Save-As and directory-rename batch).
- Support seams: `editorEdit.ts` (wrap/replace/toggle), `imageIo.ts` /
  `sha1.ts` (image dirs, path templates, dedup hashing), `documentUri.ts`
  (DocumentOrigin→URI single source of truth), `editorApiRef.ts`,
  `editorOptions.ts`, `tinymistSettings.ts` / `tinymistConfig.ts`,
  `formatDocument.ts`, `lspClient.ts`.

## Preview (`src/components/Preview/`)

- `PreviewPane.tsx` — page scroll container; buckets `lineMap` rects per
  page; desk background/padding/zoom from settings; search bar.
- `SvgPage.tsx` — memoized page as blob-URL `<img>` (off-main-thread SVG
  decode); pt-sized overlay for cursor-line rects and search tints;
  Cmd/Ctrl-click jump-to-source; zoom via wrapper width.
- `PdfViewer.tsx` — pdfjs-dist (worker as a Vite `?url` chunk), bytes via
  `readFileBytesCached`, DPR-scaled canvases, `destroy()` teardown,
  `fs_changed` reload.
- `ImageViewer.tsx` (Blob URL), `MarkdownPreview.tsx` (debounced
  react-markdown), `previewMapping.ts` (client-px ↔ page-pt),
  `previewSearch.ts` (line-rect buckets).

## Sidebar panels (`src/components/Sidebar/`)

`Explorer.tsx` (lazy tree, toolbar + context menu, inline rename, F2/Delete/
Ctrl+C/X/V/D bound only when the tree is focused), `explorerOps.ts`,
`contextMenuStore.ts` + `ContextMenu.tsx` (portal + viewport clamp),
`Packages/*` (Templates/Packages/Installed tabs, client-side filtering over
the index snapshot), `Bibliography/*` (panel + edit modal), `Project/
ProjectPanel.tsx` (`.typstpro` form; remounts on root change),
`Symbols/SymbolsPanel.tsx` + `detectMathContext.ts` (math-vs-markup
insertion). No source-control panel is currently registered — the backend
git commands exist and the `workbench.scm` title key is reserved.

## Settings, dialogs, assistant, misc

- `Settings/SettingsApp.tsx` — manifest-driven grouped cards; every control
  binds `useSetting`; theme picker; tinymist install UI. Controls:
  `Toggle/FontControl/PathControl/KeybindingControl`.
- `Dialogs/` — two orchestrations: promise-queue `useDialogStore.confirm()`
  (ConfirmDialog; danger dialogs focus Cancel) and dedicated open/close
  stores (Conflict, Recovery, BatchExport) rendered once at app root.
  `DiffCompareView.tsx` — shared allocation-bounded side-by-side diff.
- `Assistant/AssistantPanel.tsx` — chat UI over `assistantStore`;
  `aiStream.ts` (pi-agent-core + OpenAI/Anthropic SDKs with custom fetch);
  `tauriFetch.ts` routes through the Rust AI proxy (key never in webview).
- `CommandPalette/` (fuzzy filter over `useCommands()`), `Diagnostics/`,
  `Outline/`, `Search/`, `FormatToolbar/` (15 buttons, table grid picker,
  link modal, `useInsertImage`), `FormulaModal/` (KaTeX live preview;
  converts on confirm), `About/`, `common/ExternalLink.tsx` (react-markdown
  `<a>` override → `openExternalUrl`), root `ErrorBoundary.tsx`.

## Invariants

- **Revision guards**: `compiled`/`diagnostics` events older than the
  document's revision are dropped; conflict/save-state events for
  no-longer-open doc ids are dropped.
- **Anti-bounce-back**: registry-controlled text replacement suppresses
  forwarding to the backend; pending debounced pushes flush on tab
  switch/unmount.
- **Frozen configs**: `editorAppConfig` / `languageClientConfig` are frozen
  after first definition to prevent a double-init race in the monaco
  wrapper; the editor mount is sticky across transient LSP flips.
- **One LSP client**: start/stop serialized; stale generations dropped at
  enqueue time.
- **Paste safety**: model URI + editor focus re-validated after async image
  resolution before applying edits.

## Gotchas

- `optimizeDeps.exclude` for two `@codingame/monaco-vscode-*` packages is
  mandatory (pre-bundling rewrites `import.meta.url` and 404s every
  grammar/theme resource); `resolve.dedupe: ["vscode"]` likewise — see
  `vite.config.ts`.
- pdf.js needs `destroy()` not `cleanup()`, or one Web Worker leaks per
  viewed PDF.
- `SvgPage` parses the SVG viewBox instead of `img.naturalWidth` (CSS px =
  pt×4/3 would inflate coordinates ~1.333×).
- The shared editor instance means callbacks must read live tab ids via
  refs; occurrences-highlight is disabled for Typst origins to silence
  FileService read errors.
- Real Monaco/WebSocket code can't run under vitest+jsdom, so pure seams
  are split out deliberately (`editorModelSync.ts`, `tinymistSettings.ts`,
  pure exports of `appLanguageClient.ts`).
