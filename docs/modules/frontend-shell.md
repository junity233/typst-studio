# Frontend — app shell and window lifecycle

> Scope: `src/App.tsx`, `src/components/Shell/**`, `src/components/TitleBar/**`,
> `src/components/StatusBar/**`, and the app-level hooks in `src/hooks/`.

The shell is the extension host: `App.tsx` mounts the chrome, runs the
app-level hooks, and activates all extensions once. It owns everything
cross-cutting — window restore/close, session, external file routing — while
feature panels live behind extension contributions.

## Layout

- `App.tsx` — TitleBar (Windows + Tauri only), Workbench,
  StartupProblemsPanel (non-modal overlay), StatusBar, the global dialogs
  (Confirm / Recovery / Conflict / BatchExport / Formula / About),
  ContextMenu, CommandPalette, settings overlay; `activateAll()` in a
  `useEffect`.
- `Shell/Workbench.tsx` — ActivityBar + Allotment horizontal split:
  Sidebar pane (min 0, max 520, snap, persisted width) | EditorArea pane
  (min 320). Pane visibility is seeded once from session/settings.
- `Shell/ActivityBar.tsx` — icon strip from `useViews()`; toggles
  `uiStore.toggleView`; workspace-gated views disabled without a workspace.
- `Shell/EditorArea.tsx` — TabStrip + FormatToolbar + Monaco|Preview split
  + collapsible DiagnosticsPanel; both pane resizers share the module-level
  `startSashDrag` tail; scroll-sync engine, project-preview mode, per-pane
  Ctrl+wheel zoom, preview search.
- `Sidebar/Sidebar.tsx` — keep-alive host: pre-mounts every eligible view,
  toggles with the `hidden` attribute; memoizes one `lazy()` wrapper per
  view id in a module-level `lazyViewCache` (a fresh `lazy()` per render
  would silently unmount every view's state).
- `TitleBar/TitleBar.tsx` — Windows custom titlebar: File/Edit/View/Help
  dropdowns (shared ContextMenu store), drag region, window controls; menu
  builders dispatch command ids.
- `StatusBar/StatusBar.tsx` — compile status (debounced 300 ms), diagnostic
  counts, save state, conflict entry, watcher health, LSP status with
  Restart/Download actions, editor stats (Ln/Col/words/chars).

## App-level hooks (mounted from App.tsx)

`useTauriListener` (race-safe event subscription, handler in a ref),
`useTypstCompile` (backend event → store wiring), `useAppCommands` (command
dispatch + close guard), `useStartupSession`, `useWindowRestore`,
`useAutosave`, `useExternalFileRouting`, `useLspWorkspaceReconnect`,
`useTinymistConfigSync`, `useTheme`, `useLanguage`. Detail in
[frontend-state.md](frontend-state.md).

## Window lifecycle

- **Restore**: `useWindowRestore` restores window bounds and seeds the
  `ts-preview-width` / `ts-sidebar-width` localStorage keys from the session
  layout. `useStartupSession` performs one-shot session restore, racing
  `recovery_available` (400 ms ceiling) — crash recovery wins over session
  state for covered paths; the persisted `activeDocumentId` never matches
  after restart (backend mints fresh UUIDs), so activation falls back to a
  `session.lastFile` path hint.
- **Close**: `close_requested` (intercepted in `src-tauri/src/lib.rs` for
  the `main` window) triggers the dirty-check flow in `useAppCommands` —
  Save All / Don't Save / Cancel, capture + await session/window/layout
  state, write the clean-shutdown marker; the window is finally destroyed
  with `destroy()` (not `close()`, which would re-emit the event). "Don't
  Save" discards recovery snapshots per dirty doc so they are not re-offered
  next launch.
- **Single instance**: a second launch routes into the first via
  `focus_view` / `open_external_file` events (`useExternalFileRouting`,
  backend `service/file_routing.rs`).

## Gotchas

- Allotment pane min/max must stay constant; toggling only `visible` —
  changing `maxSize` on hide makes a re-shown pane clamp to 0
  (`Workbench.tsx` comment).
- Sidebar width is never persisted when non-positive (a hidden pane reports
  0) and a 180 px restore floor guards stale zeros.
- `workbench.project` sits in `REMOUNT_ON_ROOT_CHANGE` — its local form
  state is keyed to `rootPath` so unsaved edits can't leak across
  workspaces.
- ActivityBar and Sidebar keep separate `VIEW_TITLE_KEYS` i18n maps with
  different coverage; unknown ids fall back to the contributed title.
