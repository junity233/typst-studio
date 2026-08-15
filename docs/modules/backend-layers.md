# Backend — bootstrap, domain, IPC, services

> Scope: `src-tauri/src/lib.rs`, `startup.rs`, `domain/**`, `ipc/**`,
> `service/**`.

Three-layer backend: `ipc` (thin Tauri command/event wrappers — parameter
conversion only, delegate to services) → `service` (orchestration) →
`domain` (pure data models, no IO) + engines (typst_engine, render, fs,
lsp, net, persistence — see the engine docs). `lib.rs` bootstraps Tauri,
wires ~13 services into `AppState`, registers ~80 commands, and drains the
compile supervisor on exit.

## Bootstrap (`lib.rs`, `startup.rs`)

`.setup` builds the `AppState` (all `Arc`): editor, export, lsp, workspace,
settings, themes, session, net, save, watcher_health, packages,
project_config, tinymist. Startup faults degrade — any single component
failure (config dir, settings, session, recovery) falls back and reports a
`startup_problems` entry instead of blocking the window. Stale temp files
(`.typst-tmp-*` older than 24 h) are cleaned at startup; recovery
availability is announced 150 ms late so the frontend listener is mounted.

## Domain types (`domain/**`)

Types marked TS are exported to `src/lib/types.ts` via ts-rs (`export-types`
feature). Highlights:

- `document.rs` — DocumentId (Uuid, stable across Save As), WorkspaceId,
  ConflictState, DocumentKind, DocumentOrigin (TS).
- `diagnostics.rs` — Severity, 1-indexed half-open Range, Diagnostic (TS).
- `compile_status.rs` — lifecycle enum incl. transient `Slow` (TS).
- `compile_result.rs` — CompileOutcome, a serializable summary replacing
  the non-serializable `typst::Document` (TS).
- `disk_version.rs` — content identity for external-change detection:
  SipHash + length; mtime deliberately excluded (timestamp-only `touch`
  must not recompile) (TS).
- `registry.rs` — DocumentRegistry: canonical-path → DocumentId uniqueness.
- `path.rs` — canonical-path rules: symlinks resolved for existing files,
  parent+name canonicalized for Save As targets, Windows drive-letter case
  normalized; errors rather than silently falling back.
- `file_kind.rs` — extension → DocumentKind classification, single source
  of truth for all three open entry points. `.typ`/`.typst` → Typst;
  markdown family → Markdown; `.pdf` → Pdf (preview-only); image
  extensions → Image (preview-only); **unknown/no extension falls back to
  Text (editable)**.
- `outline.rs`, `source_map.rs`, `search.rs`, `git_status.rs`,
  `package_catalog.rs`, `project_config.rs`, `bib_entry.rs` — feature wire
  types (mostly TS).

## IPC command groups (`ipc/**`)

| File | Commands (representative) | Delegates to |
|---|---|---|
| `commands.rs` | `new_tab`, `open_file`, `soft/hard_close_tab`, `reactivate_tab`, `update_text`, `save_file/save_all`, `export_pdf/png/svg`, `export_batch_pdf`, `get_diagnostics`, `restart_lsp`, `install_tinymist` | editor facade, export, lsp, save coordinator |
| `fs_commands.rs` (largest) | `open_workspace*`, `close_workspace`, `read_dir`, `search_workspace`, `replace_in_files`, `create/rename/delete/copy_entry`, `open_file_by_path`, `read_file_bytes`, `save_as`, `apply_text_edits_to_disk_file`, `list_typst_files` | workspace_service, editor, fs::search, trash |
| `git_commands.rs` | `git_status`, `git_stage/unstage`, `git_commit`, `git_log` | `crate::git` directly via `spawn_blocking` (no service layer) |
| `settings_commands.rs` | `get_all_settings`, `set_setting`, `get_settings_manifest`, `open_settings`, `open_log_dir`, `list_fonts`, `pick_path` | settings service (dialogs/font listing live in Rust because the Settings window has no dialog/fs capability) |
| `theme_commands.rs`, `session_commands.rs`, `recovery_commands.rs`, `conflict_commands.rs`, `package_commands.rs`, `bib_commands.rs`, `project_config_commands.rs` | feature surfaces (themes, session, recovery, conflicts, ~10 `package_*`, bibliography parse/save, `.typstpro` get/set) | respective services; bib parsing is pure domain |
| `ai_commands.rs` | `ai_proxy_stream` | net client (key injected Rust-side, single-origin allowlist) |
| `formula_commands.rs` | `convert_latex_to_typst` | pure (tylax) |
| `net_commands.rs` | `fetch_url_to_file` | net client |
| `menu.rs` + `menu_labels.rs` | native menu build + `menu_event` emit | Rust-embedded menu labels (native menus are pre-i18n) |

Events are emitted through `TauriEmitter` (`ipc/state.rs`) mapping to wire
payloads (`ipc/events.rs`). Every `u64` field carries a ts-rs `number`
override (ts-rs maps u64 → bigint, Tauri serializes it as a JSON number).

## Services (`service/**`)

- `editor_service.rs` — IPC facade over DocumentService + CompileService.
- `document_service.rs` (largest) — document identity, buffers, registry,
  origin transitions (Untitled ↔ WorkspaceFile ↔ LooseFile), conflict
  state.
- `compile_service.rs` / `compile_worker.rs` / `compile_supervisor.rs` —
  see below.
- `dependency_graph.rs` — reverse dependency graph on canonical paths
  ("path P changed → which files recompile").
- `tab_state.rs` / `tab_store.rs` — per-tab world + meta + last result.
- `export_service.rs` — renders the tab's cached document; never triggers a
  recompile; export pinned to a revision.
- `save_coordinator.rs` — unified Save/SaveAs/SaveAll with per-doc
  `SaveState::{Idle, Saving{rev}, Saved{rev}, Failed{rev,..}}` emitted as
  `save_state_changed`; `dirty` stays true unless the atomic replace
  succeeded; failures classified into IPC error codes.
- `workspace_service.rs` — workspace open, tree, CRUD, watcher.
- `lsp_service.rs` — wrapper around lsp::LspManager.
- `session.rs`, `package_service.rs`, `project_config_service.rs` (watched
  `.typstpro` + broadcast), `theme_service.rs` (hot-reload watcher),
  `trash.rs`, `watcher_health.rs` (polling fallback re-checking open docs'
  DiskVersions when the native watcher dies), `file_routing.rs`
  (single-instance `.typ` routing).

## Compile scheduling

One long-lived std thread per tab (`compile_worker.rs`) drains a bounded
channel and compiles only the latest text; `catch_unwind` survives typst
panics. The supervisor caps concurrency at
`min(available_parallelism, 4)` via a custom `Mutex<usize>+Condvar`CountingSemaphore`
(sync workers — tokio/parking_lot semaphores don't fit), runs a 2 s
slow-compile watchdog (transient `Slow`, terminal status always follows),
backs off 5 s after ≥3 consecutive panics on a doc, and drains within 3 s
on shutdown. Cancellation is coalescing-only — a started typst compile runs
to completion. The pipeline snapshots the revision before compiling and
stamps it on every emitted event; rendering is skipped if the buffer changed
mid-compile.

## Watcher flow

`notify` watcher (debounce from `compiler.debounceMs`, default 300 ms) →
per-path `editor.handle_external_change` (clean buffer reloads, dirty →
Conflict) → root `.typstpro` hot-reload → `fs_changed` for tree refresh.
Watcher paths are matched against the **canonical** workspace root —
comparing against the raw picked root silently broke hot-reload on macOS
(`/var` vs `/private/var`) and Windows case/subst differences.

## Git module (FROZEN)

`src-tauri/src/git/**` is frozen by maintainer directive — do not edit,
refactor, or silence warnings there. Surface: gix 0.85-based status /
stage / unstage / commit / log. `gix::Repository` is Send but not Sync, so
it is re-discovered per call, and all git IPC commands wrap work in
`spawn_blocking`. Consumed only by `ipc/git_commands.rs`. CI clippy runs
without `-D warnings` because of the one known warning in
`git/status.rs`.

## Gotchas

- `tauri::async_runtime::block_on` is used deliberately in `.setup` for
  `LspService::start` (PATH lookup + TCP bind are single-digit ms; comment
  in `lib.rs` explains the tradeoff).
- Three lock families coexist by design: `parking_lot` in services,
  `tokio::sync::Mutex` in SaveCoordinator, std primitives where noted.
  `TabState.world` is intentionally NOT behind a Mutex — `EditorWorld` has
  interior locking and compiles lock-free.
- Project `extraFontDirs` are canonicalized, must stay under the workspace
  root (symlink-escape defense), and take effect only after restart.
- Native dialogs are centralized in `ipc/dialog.rs`
  (`pick_file`/`save_file`/`pick_folder`): `spawn_blocking` + the blocking
  picker, `FilePath` converted via `commands::path_buf_from`. Cancel
  semantics stay at the call site (`Ok(None)` vs a `Cancelled` error).
- Paste-destination containment (workspace root or app config dir) is
  centralized in `ipc::ensure_paste_dest`, shared by `write_bytes_to_file`
  and `fetch_url_to_file`.
