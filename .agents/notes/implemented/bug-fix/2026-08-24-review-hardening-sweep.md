# Agent Note: Hardening sweep after the 15-module code review

Status: implemented

## Problem

A 15-agent read-only review of the whole repository (frontend stores,
components, hooks, lib, extensions; backend service, ipc, persistence,
render, fs, net, lsp, settings, typst_engine; plus CI and build scripts)
surfaced a set of defects that clustered into three themes: (1) a few
"late-arriving" code paths that bypassed protections the codebase already
had elsewhere (path containment for reads, CAS re-validation around world
rebuilds, checksum verification on downloads), (2) destructive fallback
behavior in the Windows atomic-write path, and (3) user-visible correctness
bugs (i18n formatter crash-down to raw keys, Escape closing all stacked
modals, IME composition submitting forms). Individually each was small;
together they undermined the repo's own stated invariants.

## Decision

Fix the high-severity subset in one branch, one concern per commit:

- **Inactive-tab LSP edits** (`workspaceEditApplier`): the editor's content
  listener only observes the ATTACHED model, so `workspace/applyEdit`
  results applied to background tabs never reached documentsStore/the
  backend — a later save wrote stale text. `applyModelEdits` now takes an
  injected sync callback + the active id and pushes non-active-model results
  through `updateContent` + fire-and-forget `updateText` (the same pattern
  the assistant approval path already used).
- **Atomic write on Windows** (`persistence/atomic.rs`): removed the
  remove-then-rename fallback entirely; sharing violations get a short
  backoff retry, and any residual failure leaves the original intact. A
  failed save must never destroy the on-disk document.
- **Read-path containment** (`ipc::ensure_read_source`): `read_file_bytes`
  and the bibliography parse/save family now require open-document /
  workspace / config-dir / exact-dialog-grant paths. The backend records the
  grant itself in `pick_image_file` (`AppState.dialog_grant`), so the webview
  can consume but never mint an authorization.
- **API key masking** (`settings/service.rs`): manifest keys flagged
  `"secret": true` (`ai.apiKey`) are masked in `get_all_settings`,
  `get_setting`, and the `settings_changed` broadcast; `set_setting` rejects
  writing the sentinel back. Settings UI renders secrets as password inputs
  that only send explicitly typed values. Restores the documented invariant
  "the API key never crosses to the webview".
- **htmlToTypst**: dynamic ``` fences for `<pre>` (injection via early fence
  close), leading-block-marker escaping inside list items, bracket-form
  `#sub[..]`/`#super[..]`, and empty tables emit nothing instead of
  non-compiling `columns: 0`.
- **Concurrency**: Save As / rename rebind now CAS-verifies the buffer across
  the expensive world rebuild (retry with fresh snapshot); in-place save
  re-checks conflict state AFTER the write window so an external change
  landing mid-save surfaces instead of being silently overwritten;
  `workspaceStore.toggleExpand` commits through functional `set`; the LSP
  WebSocket accept loop bounds the handshake at 10s (a silent local TCP peer
  can no longer wedge the accept loop).
- **Blocking IO**: package downloader client gets connect+total timeouts
  (a stalled CDN previously hung the compile worker forever); recovery
  snapshots compute their disk version on the recovery worker at flush time
  instead of reading the file synchronously per keystroke on the IPC path.
- **Gates**: CI gained a ts-rs drift step (regenerate + `git diff
  --exit-code src/lib/types.ts`); release builds use `npm ci`;
  `fetch-grammar.mjs` verifies the pinned VSIX against a hardcoded SHA-256
  AND OpenVSX's `.sha256` sidecar before touching the output dir; every
  `[dependencies]` entry in Cargo.toml now carries a rationale comment and
  the dead `comemo` dependency is gone.
- **User-visible bugs**: tab tooltips rendered raw keys because the locale
  used an unregistered i18next formatter (`{{dirty, client}}`) — replaced
  with plain interpolation of a precomputed mark; stacked modals now use a
  monotonic escape-stack ticket so Escape closes exactly the topmost layer;
  assistant Stop is recognized as AbortError rather than surfacing as a red
  error bubble, and the approval resolver preserves terminal status; Enter
  submit guards `isComposing`/keyCode 229 in LinkModal/SearchPanel;
  BibEditModal takes `existingKeys` and blocks duplicate keys in add mode;
  extension activation is awaited (async-safe) and failures land in the
  startup-problems banner instead of console-only.

## Alternatives considered

- Fix only the P0 items and leave P1s to follow-ups — rejected: several P1s
  (save-window conflicts, downloader hang) were cheap now but expensive as
  production incidents; the review evidence was fresh.
- Per-command ad-hoc path checks for `read_file_bytes` — rejected in favor
  of one shared guard (`ensure_read_source`) mirroring `ensure_paste_dest`;
  per-command checks rot.
- Masking API keys only in `get_all_settings` — insufficient: the
  `settings_changed` broadcast and `get_setting` are separate channels to
  the same webview; all three mask.
- `stopImmediatePropagation` for the Escape bug — registration order decides
  the winner, not visual z-order, so stacked dialogs would still misbehave
  depending on mount order luck.
- Keeping the Windows remove-then-rename rename fallback behind a flag —
  flags rot toward the unsafe default; the safe failure mode (error, buffer
  stays dirty) needs no fallback.

## Consequences

The read/write containment story is now symmetric and greppable
(`ensure_paste_dest` / `ensure_read_source`). Secrets never reach the
webview in plaintext; the settings UI communicates "configured" via the
sentinel placeholder instead of the value. A failed save on a locked file
leaves the document intact and reports an error. Extension activation
failures surface in the startup-problems banner. The ts-rs drift gate makes
wire-type staleness a CI failure. Remaining known gaps recorded during the
review (menu dispatch tests, LSP relay coverage, `source_map.rs` density,
frozen `git/status.rs` Conflict mapping) stay tracked for future rounds.
