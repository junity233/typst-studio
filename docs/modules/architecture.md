# Architecture overview

> Scope: the whole app. Module detail lives in the sibling docs; this one
> gives the map and the cross-cutting invariants.

Typst Studio is a Tauri v2 desktop app with two processes: a React 19 +
TypeScript webview (`src/`) and a Rust core (`src-tauri/`) that embeds the
official Typst compiler (typst 0.15). The frontend never touches the file
system directly — every disk operation is a Tauri command in
`src-tauri/src/ipc/`, and all file I/O goes through service layers that
enforce the invariants below.

## Layering

```
React components (src/components)
  → zustand stores + hooks (src/store, src/hooks)
    → typed IPC wrappers (src/lib/tauri.ts)          [frontend boundary]
      → Tauri commands (src-tauri/src/ipc)            [thin: parse + delegate]
        → services (src-tauri/src/service)            [orchestration]
          → domain (pure types) + engines
            typst_engine / render / fs / lsp / net / persistence
```

Workbench features are in-tree extensions (`src/extensions/<id>/`) that
register views, commands, and menu items into observable registries
(`src/extensions/registry.ts`); the shell renders contributions generically.
See [frontend-extensions.md](frontend-extensions.md).

## The three golden paths

**Edit → compile → preview.** Monaco edits are debounced and pushed as
`update_text` with a monotonically increasing revision. The backend spawns
one long-lived worker thread per tab (`service/compile_worker.rs`) that
coalesces pending edits and compiles only the latest text; a process-wide
supervisor caps concurrency at 4, flags slow compiles (>2 s → transient
`Slow` status), and backs off after repeated typst panics. Every emitted
`compiled` / `status` / `diagnostics` event carries the revision it compiled;
the frontend drops any event whose revision is older than the document's
(`src/hooks/useTypstCompile.ts`, `src/store/documentsStore.ts`). Pages
arrive as SVG strings; `setPages` merges changed pages by index so unchanged
pages keep string identity and memoized components skip re-decoding.

**Save.** All saves route through `service/save_coordinator.rs` with a
per-document `SaveState` machine (`save_state_changed` events) and atomic
writes (`persistence/atomic.rs`: same-dir temp file → fsync → rename).
External-change detection compares a content hash (`domain/disk_version.rs`,
SipHash + length, mtime excluded) — a clean buffer silently reloads, a dirty
buffer surfaces the conflict dialog instead of being overwritten.

**Language features.** tinymist runs as a child process managed by the Rust
side (`src-tauri/src/lsp/`): a localhost WebSocket server relays LSP frames
between the webview's MonacoLanguageClient (`src/components/Editor/appLanguageClient.ts`)
and tinymist's stdio. Restarts bump a generation number; both ends drop
stale-generation traffic.

## Event surface (backend → frontend)

`compiled`, `diagnostics`, `status`, `conflict`, `save_state_changed`
(per-document); `fs_changed` (workspace tree), `settings_changed`,
`themes_changed`, `project_config_changed` (broadcasts); `lsp_status`,
`tinymist_install`; `recovery_available`, `startup_problems`;
`close_requested`, `menu_event`, `settings_window`; `focus_view`,
`open_external_file` (single-instance routing), `docs_rebound`
(rename/delete re-binding). Wrappers: `src/lib/tauri.ts`, emitted from
`src-tauri/src/ipc/events.rs` and `src-tauri/src/lib.rs`.

## Cross-cutting invariants

- **Canonical-path identity.** At most one open document per canonical path,
  enforced by `domain/registry.rs`; symlinks resolved, Windows drive-letter
  case normalized (`domain/path.rs`).
- **Atomic persistence everywhere.** Saves, `settings.json`, `session.json`,
  recovery snapshots, and package index all use the same atomic write
  primitive; `.bak` rotation guards the JSON stores.
- **Trash-first deletion.** Workspace deletions go to the OS trash
  (`service/trash.rs`); permanent delete is a separate explicit command.
- **Fail-loud startup.** Any single startup component failing (config dir,
  settings, session, recovery) degrades to a fallback + `startup_problems`
  banner, never blocks the window (`startup.rs`).
- **Key never in the webview.** The AI proxy injects `ai.apiKey` Rust-side
  and enforces a single-origin allowlist (`ipc/ai_commands.rs`).

## Frozen module

`src-tauri/src/git/**` is frozen by maintainer directive (see
[backend-layers.md](backend-layers.md#git-module-frozen) for its surface).
CI runs clippy without `-D warnings` because of it
(`.agents/notes/implemented/process/2026-08-15-clippy-allows-known-git-warning.md`).

## Module map

| Doc | Covers |
|---|---|
| [frontend-shell.md](frontend-shell.md) | App bootstrap, Workbench, TitleBar/StatusBar, window lifecycle |
| [frontend-extensions.md](frontend-extensions.md) | Extension system, registries, keybindings, command dispatch |
| [frontend-components.md](frontend-components.md) | Editor (Monaco/LSP), Preview, Sidebar panels, dialogs, Assistant |
| [frontend-state.md](frontend-state.md) | zustand stores, hooks, event wiring |
| [frontend-lib.md](frontend-lib.md) | `src/lib` pure logic, IPC wrappers, htmlToTypst, i18n |
| [backend-layers.md](backend-layers.md) | lib.rs bootstrap, domain, IPC command surface, services |
| [backend-typst-engine.md](backend-typst-engine.md) | Typst world/VFS/fonts, compile, render/export pipelines |
| [backend-infra.md](backend-infra.md) | fs/net/lsp/persistence/settings, app data locations, security |
| [build-and-testing.md](build-and-testing.md) | Build chain, generated assets, tests, CI, hooks, gates |
