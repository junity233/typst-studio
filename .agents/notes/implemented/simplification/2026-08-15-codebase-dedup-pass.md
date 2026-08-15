# Agent Note: Deduplication pass across frontend lib/stores and backend IPC

Status: implemented

## Problem

A sweep of the tree for repeated fragments found the same ~10–55 line blocks
copy-pasted across call sites, in the exact places where divergence is a bug:

- `ipc/commands.rs`: `export_png` and `export_svg` were whole-function twins
  (only filter/renderer/pixel-per-pt differed); the native-dialog pipeline
  (clone app → `spawn_blocking` → join-error map → `FilePath` conversion) was
  hand-rolled at 9 call sites across 3 files; the `IpcError → AppError`
  re-wrap closure existed 3× plus a private constructor in
  `package_commands.rs`.
- `service/document_service.rs`: `open_from_disk` was a byte-identical twin of
  `open_from_content`; the tab-clone-with-`NotFound` prologue appeared 7×.
- `ipc/fs_commands.rs`: `delete_entry` / `delete_entry_permanent` differed
  only in the disk op; `fs/search.rs` repeated the walk prelude (dir filter,
  include glob, rel exclusion, target pin, byte guard) 3×.
- Frontend: 16 same-shape event wrappers in `lib/tauri.ts`; 7 hand-rolled
  guarded doc-update blocks in `documentsStore`; `replaceAll`/`replaceOne`
  near-clones in `searchStore`; 5 modal dialogs each hand-rolling the
  Escape-to-close window listener; pane-geometry localStorage keys + clamped
  parses duplicated between the pane components and `useAppCommands`
  (the `ts-preview-width` literal + min 240 already lived in two files);
  `ui-types.ts` hand-mirrored four ts-rs wire types (one had drifted:
  `durationMs?: number` vs the generated `number | null`).
- Infra: `package_index.rs` and `lsp/installer.rs` wrote the 2 MB index cache
  and the committed version marker with plain `std::fs::write`, breaking the
  "all overwrite-in-place persistence goes through `atomic::write_bytes`"
  invariant; `backup.rs::quarantine_corrupt` carried a dead recomputation
  block; `workspaceStore` exported an unused `inWorkspace` that was the exact
  Windows-backslash footgun `lib/workspacePath.ts` documents against.

## Decision

Extract one shared implementation per family and delete the copies; preserve
every behavior difference explicitly (each divergent policy stays at its call
site as data or a one-line closure):

- `lib/tauri.ts`: `onEvent<P>` / `onProjectedEvent<P, V>` factories; the 16
  plain wrappers and 3 projecting wrappers become consts. `onCloseRequested`
  (no payload) stays hand-written.
- `lib/ui-types.ts`: re-exports `CompileStatus`/`CompiledPayload`/
  `DiagnosticsPayload`/`StatusPayload` from the generated `types.ts`; the
  manual mirror duty is gone. `documentsStore`/`tabsStore` `setStatus`
  signatures widened to the real wire shape (`durationMs?: number | null`).
- `documentsStore`: internal `patchDoc(id, doc => Partial | null)` absorbs
  the lookup/no-change/shallow-merge prologue; actions keep only their unique
  logic (revision guards return `null`).
- `searchStore`: shared `replace(target)` + `buildQuery`; `replaceAll`/
  `replaceOne` are one-liners pinning the target.
- `lib/layoutPrefs.ts` (new): the three pane-geometry keys + shared
  `PREVIEW_WIDTH_MIN` + `readStoredNumber`; restore/capture sites keep their
  own clamp-vs-default policy (preview falls back to the default below min,
  sidebar clamps to the floor, capture uses floor 0 for the sidebar).
- `hooks/useEscapeToClose.ts` (new): window-level listener while `active`,
  callbacks in refs (attach/detach only on `active` flips), `ignoreWhile`
  covers ConflictDialog's busy guard. Adopted by About/Recovery/Conflict/
  Confirm/BibEdit; BatchExportDialog keeps its own listener (document-level,
  no stopPropagation — deliberately different semantics).
- `ipc/error.rs`: `impl From<IpcError> for AppError` (NotFound → typed
  variant, everything else rides `AppError::Code` verbatim); `AppError::ipc`
  constructor. The three re-wrap closures, `package_commands`' private `ipc`,
  and the hand-built `Code` sites now all funnel through these.
- `ipc/commands.rs`: `export_image_pages(app, state, id, rev, path,
  ImageFormat)`; `ipc/fs_commands.rs`: `delete_entry_impl(.., DeleteMode)`.
  Both `#[tauri::command]`s keep their names/args (wire surface unchanged).
- `ipc/dialog.rs` (new): `pick_file`/`save_file`/`pick_folder` doing the
  spawn_blocking pipeline + `path_buf_from`; filters/default-name are data.
  `open_workspace`/`save_as` now route through `path_buf_from` (error text
  changes from "invalid folder path" to the shared "invalid file path").
- `document_service`: `open_from_disk` delegates to `open_from_content`;
  `tab_cloned(id)` replaces the 7 prologues.
- `fs/search.rs`: `walk_candidates(root, exclude, include, target)` owns the
  traversal filters + byte guard; `search`/`replace_candidates`/
  `replace_compute` keep only read/match/splice.
- Infra: index cache + version marker writes go through
  `persistence::atomic::write_bytes`; `quarantine_corrupt`'s dead block
  removed; unused `workspaceStore.inWorkspace` deleted.

No wire format, event name, or public command signature changed. New
pinning tests: `lib/__tests__/layoutPrefs.test.ts`,
`hooks/__tests__/useEscapeToClose.test.tsx`, and in-module tests for
`From<IpcError> for AppError`.

## Alternatives considered

- Fold `lspStore` + `tinymistInstallStore`'s refcounted-subscription machinery
  into one factory (~130 duplicated lines) — deferred: the acquire/release
  semantics are subtle (queueMicrotask-deferred release), `lspStore`'s
  generation gating is pinned by tests, and the tinymist store has none; it
  deserves its own focused PR rather than a batch.
- Unify the two `.typ` walkers (`fs_commands::collect_typ_files` vs
  `project_config_service::walk_typ`) — deferred: the two commands back
  different frontend surfaces with different payload shapes; merging needs a
  decision about which exclude-glob behavior wins.
- A generic `run_blocking` helper for the ~30 join-error maps — deferred:
  most sites now go through `ipc::dialog` (dialog picks) or already have
  bespoke contexts; the remainder are mostly one-liners in feature commands
  where a shared helper saves little.
- BatchExportDialog into `useEscapeToClose` — rejected: its listener is
  document-level and deliberately does not stop propagation; forcing the
  shared hook would change Escape semantics mid-export.
- Deleting `ui-types.ts` entirely and fixing all import sites to `types.ts` —
  rejected: the file also hosts genuinely frontend-only types
  (`MenuEventPayload`); the re-export keeps the diff mechanical.

## Consequences

- Roughly 470 net lines removed; PNG/SVG export, trash/permanent delete, and
  the three search/replace walks can no longer drift apart — a fix in the
  shared body now lands everywhere at once.
- New dialog/error/walk helpers are the canonical homes: extend
  `ipc::dialog`, `From<IpcError>`, `walk_candidates` instead of writing a
  local variant.
- `frontend-lib.md` / `frontend-state.md` / `frontend-components.md` /
  `backend-layers.md` / `backend-infra.md` updated in the same PR (the
  ui-types mirror-lockstep instruction is gone).
- Known flake observed once during verification:
  `typst_engine::vfs::tests::concurrent_upsert_and_get_are_safe` failed
  under full-suite parallel load, then passed 4/4 (isolated ×3, full ×1) on
  both the changed and the clean tree — pre-existing and load-dependent,
  unrelated to this pass; worth its own investigation.
