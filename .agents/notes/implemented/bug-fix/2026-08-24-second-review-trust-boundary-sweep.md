# Agent Note: Second review sweep — trust boundaries and race guards

Status: implemented

## Problem

A follow-up 16-agent read-only review (after the 2026-08-24 hardening
sweep) found that the most serious remaining defects were all at "seams":
IPC commands written before the containment convention landed, settings
values validated only on the write path, and frontend guards whose escape
hatches let a superseded async result win anyway. Individually each was a
small hole; together they meant a compromised webview retained an
arbitrary file read, write, delete, and process-spawn primitive, and two
frontend races could visibly corrupt user-visible state.

## Decision

Close the trust-boundary holes and the confirmed correctness bugs, one
concern per commit:

- **`bibliography_save` containment** (`ipc/bib_commands.rs`): the "dumb
  write primitive" was the one command in its family without
  `ensure_read_source`; it is now guarded like `bibliography_save_entries`.
  The module doc's claim that the whole family guards its paths is true
  again.
- **`open_file_by_path` containment** (`ipc::ensure_open_source`, new):
  reading arbitrary absolute-path text into the webview violated the
  documented threat model (`read_file_bytes` has been guarded since its
  introduction; this older command was missed). Beyond everything
  `ensure_read_source` admits, the open flow legitimately needs two more
  backend-owned origins: disk paths recorded in the backend-owned session
  (startup restore) and a new `open_grant` minted by the single-instance
  callback immediately before it emits `open_external_file`. Both are
  exact-match; neither can be minted by the webview.
- **`bibliography_discover` root anchoring** (`ipc/bib_commands.rs`): the
  walk now uses only the backend's own workspace root; the caller-supplied
  `rootPath` argument is ignored (kept for wire compatibility). An
  arbitrary-root walk plus per-file entry counting had been an enumeration
  oracle.
- **Package uninstall traversal** (`service/package_service.rs`): IPC
  `name`/`version` must parse as `PackageSpec` components before any join
  with the cache root, so `"../../x"` cannot steer `remove_dir_all`
  outside the cache. typst's version grammar is strictly numeric
  `major.minor.patch`; semver pre-release tags are rejected too.
- **Settings load-side validation** (`settings/service.rs`): manifest
  constraints ran only on `set`; a hand-edited settings.json fed values
  like `pngPixelPerPt=1e9` straight into consumers. Loading now re-runs
  validation per known key and resets violations to defaults (logged).
  Non-finite numbers are rejected outright — NaN passed every min/max
  comparison because both branches are false.
- **Consumer-side clamp** (`render/png.rs`): `PngRenderer::new` clamps
  pixel-per-pt to [0.5, 8] and falls back to 2.0 for non-finite input.
  Validation can fail loud; this is the backstop that keeps a bad value
  from driving a multi-GB allocation.
- **Watcher busy-spin floor** (`fs/watcher.rs`): `compiler.debounceMs: 0`
  made `next_flush = now + 0` always due — the flush thread burned a core.
  The window is clamped to a 1 ms floor.
- **Startup-problems pull fallback** (`get_startup_problems` + App mount
  fetch): the push event raced listener registration and could be lost
  permanently; the setup now also stores problems in `AppState` and the
  frontend fetches once on mount and merges.
- **Fail-loud setting saves** (`useSetting.ts`): every settings control
  fired `void store.set(...)`; a rejected `set_setting` produced a silent
  snap-back plus an unhandled rejection. The setter now routes failures to
  `alertIpcError("settingSaveFailed", …)` (new en/zh key).
- **htmlToTypst content fidelity**: `/` joined the escape set — pasted
  URLs opened Typst line comments that swallowed the rest of the line
  (`/*` opened blocks); unknown block containers (`<section>`,
  `<article>`) recurse as blocks so multi-paragraph sections keep their
  breaks instead of collapsing into one run-on paragraph. The bare-link
  optimization compares against escaped text so URL links stay bare.
- **Search-store races** (`store/searchStore.ts`): the empty-query early
  out now claims a `runSeq`, so a late in-flight response cannot resurrect
  stale results over the cleared state; `applyReplaceOutcome` skips docs
  whose local revision moved past the replace outcome and never lowers a
  revision (a backwards revision let stale compile events pass the
  staleness guard).
- **LSP timeout zombie** (`appLanguageClient.ts`): the 45 s start timeout
  left the WebSocket open and checked only generation on `onopen` — a late
  handshake built a full client over the Failed state. The timeout closes
  the socket and every handler checks the per-attempt settled flag first.
- **Superseded keystroke pushes** (`monacoModelRegistry` +
  `MonacoEditor`): controlled replaces (conflict use-disk, global replace,
  assistant edits) no longer race the debounce flush — the flush drops a
  pending push whose revision the replace already overtook via
  `lastSyncedRevisionOf`.
- **IME composition guards**: the global keydown dispatcher, palette
  arrow-key navigation, the keybinding recorder, and the settings
  paths-input Enter all skip `isComposing`/keyCode 229 events, matching
  the guard the palette's Enter already had.
- **Windows CI**: the rust job gained a `windows-latest` matrix leg (this
  is a win32-first app whose platform-specific code had zero CI coverage);
  clippy+test run on both platforms, the ts-rs drift gate stays Linux-only.

## Alternatives considered

- Guarding `open_file_by_path` with plain `ensure_read_source` — rejected:
  legitimate flows open files outside every contained root (double-clicked
  `.typ` via single-instance, session restore of loose files). A separate
  `ensure_open_source` keeps the extra origins explicit, backend-minted,
  and exact-match rather than widening the shared read guard for everyone.
- Frontend cancel hooks wired into each of the three controlled-replace
  call sites — rejected: three call sites drift; deriving staleness from
  the registry's own `lastSyncedRevision` at flush time covers all present
  and future callers from one place.
- Rejecting NaN only at the PNG consumer — insufficient: any current or
  future numeric setting would re-expose the hole; non-finite rejection
  belongs in the shared validator, with the renderer clamp as defense in
  depth.
- Emitting `startup_problems` later (bigger delay) — rejected as fragile;
  a pull command makes the loss impossible instead of less likely.

## Consequences

The compromised-webview story is closed end-to-end: arbitrary read
(`open_file_by_path`, discover), arbitrary write (`bibliography_save`),
arbitrary delete (`uninstall`), and arbitrary spawn (`tinymistPath`
relaunch still trusts configured paths by design, but every unguarded
filesystem primitive is gone). Settings corruption self-heals at load with
loud logs instead of poisoning consumers. The remaining known gaps from
the review (PDF eager-load memory, assistant streaming re-renders,
keybinding registration-order semantics, extension-title i18n snapshots,
fs-plugin dead surface) are recorded for future rounds and are not
regressions introduced here.
