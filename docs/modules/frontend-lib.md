# Frontend — lib (pure logic) and i18n

> Scope: `src/lib/**`, `src/i18n/**`, `src/assets/symbols/`.

`src/lib` is the framework-free heart of the frontend (React-free; several
modules do import stores — "framework-free" means no React). It hosts the
single IPC surface, typed wire types, path logic, save/export
orchestration, and the paste-conversion pipeline.

## IPC surface and types

- `tauri.ts` — the ONLY place that calls `invoke`: ~80 typed wrappers
  (tabs, workspace, fs, export, packages, bibliography, session, recovery,
  conflicts), plus a full in-browser fallback (`browserInvoke` + localStorage
  settings + inlined themes) gated on `isTauri` so vitest/jsdom works.
  `on*` event wrappers are consts built by the internal `onEvent` /
  `onProjectedEvent` factories.
- `types.ts` — ts-rs-generated wire types (`OpenedDocument`, `Session`,
  `ErrorCode`, `CompiledPayload`, …). Do not edit manually; regenerate with
  `cargo test --features export-types` (src-tauri).
- `ui-types.ts` — hand-written frontend-only types (`MenuEventPayload`);
  the wire payload types (`CompileStatus`, `CompiledPayload`,
  `DiagnosticsPayload`, `StatusPayload`, LSP payloads) are re-exported from
  `./types` — no manual mirrors to keep in sync.
- `ipc-error.ts` — `toIpcError` narrowing of `{code, message, details?,
  recoverable}` rejections; `isCancelled`; `formatSaveErrorMessage` (i18n
  per code). The `Cancelled` code is never a failure.

## Save / export / session orchestration

- `commands.ts` — `saveTab`, `closeTabWithConfirm` (discard → hardClose +
  discardRecovery), close-others/right/all/saved.
- `saveDocument.ts` — revision-pinned flush (`flushDocumentSnapshot`) and
  `maybeAutoExportAfterSave` (400 ms trailing debounce, fire-and-forget,
  never dialog-triggered).
- `exportTarget.ts` — resolves the export target (project main file if set,
  else active tab); expands `[export] outputPath` macros via `pathMacros`.
- `session.ts` / `windowState.ts` / `layoutState.ts` — session capture and
  restore; pure `clampWindowToBounds` (96 px min visibility) so restored
  windows never reopen off-screen; layout merge where session wins over
  `window.*` settings.

## Path logic (Windows-first)

- `workspacePath.ts` — join, equality (case-insensitive on Windows),
  containment, `fileUriToWorkspaceRel` (incl. UNC hosts; `file:///D:/…`
  strips the leading slash before drive letters; `localhost` dropped).
- `relativePath.ts` — pure relative path with forward-slash output; null
  across drive anchors.
- `assistantPath.ts` — lexical pre-check for AI tool paths (rejects `..`
  escapes); the Rust-side containment check is the real boundary.

## Other modules

- `pathMacros/` — `expandTemplate(template, ctx, {unknown})`: `$${name}`
  escapes to a literal; modifier `:default` gives a fallback, `?` makes a
  macro required (throws); unknown-macro default is `keep`. Context:
  workspace, title, fileDir, fileName, filePath, hash, ext, timestamp,
  index.
- `viewerByteCache.ts` — LRU-bounded (8) byte cache for binary viewers;
  invalidated only by workspace-scoped `fs_changed` (loose files outside
  the workspace never refresh — known limitation, mirrored against
  `service/tab_store.rs`). Buffers are shared — never mutate in place.
- `diff.ts` — pure LCS line/word diff with allocation caps (4 M line cells
  / 250 k word cells) and coarse prefix/suffix fallback.
- `openFile.ts` (open-or-reactivate, hidden tabs reactivate),
  `openLink.ts` (http/https/mailto/tel allow-list → opener plugin),
  `editableTarget.ts` (Monaco's hidden textarea deliberately NOT an
  editable target), `aiProxy.ts` (Tauri Channel streaming; desktop-only),
  `aiLog.ts` (dev-only logging, no-op in prod), `compileTiming.ts`
  (dev-only latency instrumentation, cap 5 revisions), `textStats.ts`
  (CJK-aware word count), `appInfo.ts`, `platform.ts`, `layoutPrefs.ts`
  (pane-geometry localStorage keys + `readStoredNumber`, shared by the pane
  components' restore path and `useAppCommands`' session capture).

## htmlToTypst paste pipeline (`src/lib/htmlToTypst/`)

`index.ts` orchestrates: `wordCleanup` → DOMParser → `blocks` walk.

- `wordCleanup.ts` — detects Word/Outlook HTML (`mso-`, ProgId, `o:p|w:|`
  `v:|m:|st1:` tags) and strips conditional comments (regexes bounded to
  `{0,4000}?` against backtracking blowups), Office namespaces, `mso-*`
  styles, `Mso*` classes; normalizes entities (smart quotes, NBSP, …).
- `blocks.ts` — h1–h6 → `= …`; lists (max depth 6); blockquote → `#quote`;
  pre → fenced code; hr → `#line(length: 100%)`; tables dispatched.
  `escapeLeadingBlockMarker` guards a leading `= + - /` so pasted text
  can't become headings/lists.
- `inline.ts` — b/strong `*…*`, i/em `_…_`, code spans with adaptive
  backtick fences (longest inner run + 1), links via `#link("…")`, style
  sniffing for del/u/mark/sub/sup.
- `tables.ts` — `#table(columns: N, table.header(…))`; colspan padded,
  rowspan flattened with a warning.
- `escape.ts` — `escapeTypst` (markup) vs `escapeTypstStr` (string
  literals: only `\` and `"`).
- `images.ts` — placeholder emission + `PendingImage` records; ext
  inference (jpeg→jpg, svg+xml→svg, default png).

## i18n (`src/i18n/`)

`index.ts` initializes i18next: languages `en`/`zh`, default namespace
`common`, resources via eager `import.meta.glob("./locales/*/*.json")` —
adding a namespace is one JSON file per locale. `resolveLanguage` maps
navigator `zh*` → zh else en. `settingsManifest.ts` localizes manifest
labels at render time with en → literal fallback. Parity between locales is
gated by `src/i18n/__tests__/keyParity.test.ts` (namespace sets, per-key
structural diff, shape mismatches, empty values) — see AGENTS.md.

`src/assets/symbols/typst-symbols.json` — curated Typst `sym` glyph data
for the Symbols panel (inserted as `#sym.<name>` in markup, bare `<name>`
in math).
