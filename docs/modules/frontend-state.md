# Frontend — stores and hooks

> Scope: `src/store/**` (~30 zustand stores), `src/hooks/**`.

One `create()` store per domain file — no slice composition, no zustand
persist middleware (persistence goes through backend IPC). Hooks are the
IPC bridge: root-mounted hooks subscribe to Tauri events and write into
stores; stores call commands through `src/lib/tauri.ts`.

## Store inventory

**Documents & tabs** (domain vs. view split)
- `documentsStore.ts` — normalized `documents: Record<id, Document>`;
  open/upsert/close, revision-bumped `updateContent`, revision-guarded
  `setStatus`/`setPages`, `setConflict`, `markSaved` (revision compare-and-
  set), `rebindDocPath`.
- `tabsStore.ts` — view state only (`tabs`/`hidden` LRU/`activeId`);
  `openTab`/`openPath`/`softClose`/`reactivate`/`hardClose`; module helpers
  `useActiveDocument`, `removeDocFromStores` (coordinated teardown),
  `initTabs`.

**Workspace & files**: `workspaceStore.ts` (root, lazy `tree`, `expanded`;
CRUD ops), `explorerSelectionStore.ts`, `fileClipboardStore.ts` (copy/cut;
lazy cut — the move happens on paste), `watcherHealthStore.ts` (polls
`get_watcher_health`).

**Backend mirrors**: `settingsStore.ts` (hydrate + `settings_changed`),
`projectConfigStore.ts` (`project_config_changed`, schema version 2),
`themeStore.ts` (`themes_changed`, monotonic apply-token guard),
`lspStore.ts` (forward-only generation; refcounted subscription),
`tinymistInstallStore.ts` (same refcounted pattern), `saveStateStore.ts`,
`diagnosticsStore.ts` (per-doc `compiler`/`tinymist` slots, cached deduped
`combined`), `startupProblemsStore.ts`.

**Feature stores**: `searchStore.ts` (monotonic `runSeq` staleness guard;
controlled replace into Monaco), `packagesStore.ts` (full index + filter),
`bibliographyStore.ts` (`discoverGen`/`loadGen` race guards, `failedPaths`
anti-loop), `batchExportStore.ts` (phase machine; backend-only tabs),
`assistantStore.ts` + `assistantTools.ts` + `assistantPrompt.ts` (agent
tools, approval gate, system prompt), `symbolsStore.ts`,
`editorStatsStore.ts`.

**UI/dialog stores**: `uiStore.ts` (pane toggles, `activeViewId`),
`dialogStore.ts` (queued one-at-a-time confirm), `conflictDialogStore.ts`,
`recoveryStore.ts`, `commandPaletteStore.ts`, `aboutModalStore.ts`,
`formulaModalStore.ts`.

## Hook inventory

`useTauriListener` (race-safe subscription), `useTypstCompile` (event →
store wiring incl. conflict surfacing rules), `useAppCommands` (dispatch,
keybinding overrides, close guard, session capture), `useStartupSession`,
`useAutosave` (off/afterDelay/onFocusChange; pure `selectAutosavable`),
`useSetting` (reactive dot-path read with manifest default fallback) +
`readSetting`, `useLspWorkspaceReconnect` (reconnects only after the client
reached Ready once — first-connecter-wins backend rule),
`useExternalFileRouting`, `useWindowRestore`, `useTheme`, `useLanguage`,
`useWheelZoom` (clamped step zoom), `useDebounce`,
`useEscapeToClose` (window-level close-on-Escape for modal portals;
callbacks in refs so the listener attaches only while active).

## Patterns

- Cross-store coordination happens via `useXStore.getState()` inside
  actions, never imports of hook values.
- Broadcast stores subscribe once per window (module-level `subscribed`
  flag); status feeds use refcounted memoized subscriptions with
  microtask-deferred release.
- Components must select reference-stable values (frozen `EMPTY`, cached
  `combined`) — zustand v5 loops on unstable selectors.
- Large preview payloads commit inside `startTransition`.
- Backend→Monaco content changes use the registry's controlled replace — a
  plain `updateText` would be dropped by the backend staleness guard.

## Invariants (pinned by tests where noted)

- **Revision guard**: `setStatus`/`setPages` drop events with
  `revision < doc.revision`; `updateContent` bumps and resets status to
  `idle`. `compiledRevision` starts at `revision - 1` on open; while
  `compiledRevision < revision` the lineMap is stale and scroll-sync must
  not realign.
- **Incremental `setPages`**: on `full` or length mismatch rebuild the
  array; otherwise merge `changedPages` by index, preserving unchanged
  string refs (`__tests__/documentsStore.setPages.test.ts`).
- **Conflict rules**: typing does NOT clear a conflict; only explicit
  resolution or `markSaved` does. The dialog surfaces only for existing,
  non-hidden docs and is not reopened while open.
- **Dirty tracking**: `markSaved` clears dirty only when the saved revision
  matches the current one; hidden (soft-closed) docs still count for the
  close guard.
- **Tab lifecycle**: X soft-closes; hidden tabs LRU-evict above the
  `tabs.maxHidden` setting (default 10) which hard-closes;
  `openFileByPath` must be paired with `tabsStore.openPath` or no tab
  appears. Batch export and the assistant's `read_file` open BACKEND-only
  tabs and must hard-close them to avoid stranded compile workers.
- **Save-As origin coherence**: a path change re-roots the origin to
  `looseFile` at the new parent; rename preserves variant and never touches
  dirty/content/revision.
- **Settings are never optimistic**: `set` fires `set_setting` and the local
  copy updates only via the `settings_changed` broadcast.
- **Diagnostics dedup key** is (severity, range, message) — `code`
  excluded; compiler-sourced wins.

## Gotchas

- `openPath` re-pushes content+revision to the backend for typst docs to
  guarantee a compile (the `compiled` listener may attach after the
  backend's initial compile).
- Monaco can swallow menu accelerators — shortcuts re-dispatch via the
  document-level capture listener.
- `open-recent:` menu ids carry either a URI-encoded path or a legacy
  integer index; indices can go stale mid-session.
- Session layout wins over `window.*` settings on restore; compile output
  and diagnostics are never persisted.
