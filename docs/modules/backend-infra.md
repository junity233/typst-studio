# Backend — infrastructure (fs, net, lsp, persistence, settings)

> Scope: `src-tauri/src/{fs,net,lsp,persistence,settings}/**`, `paths.rs`,
> `diagnostics.rs`, `error.rs`.

## fs

- `watcher.rs` — raw `notify` watcher (not a debouncer crate): events push
  deduped paths into a mutex buffer; a flush thread delivers once per
  debounce window (`compiler.debounceMs`, default 300 ms). `WatcherGuard`
  drop stops it.
- `tree.rs` — one-level lazy `read_dir`; skips `.git`, `target`,
  `node_modules` (`IGNORED_DIRS`, also exposed as a HashSet via
  `ignored_dirs()` for the search/bib walkers).
- `resolver.rs` — `FileResolver`: FileId ↔ disk path, Project-root vs
  Package-root dispatch.
- `search.rs` — line-based literal/regex workspace search + replace
  computation (pure; writes happen in the service). The shared
  `walk_candidates` prelude (dir/include/exclude/target filters + byte
  guard) serves `search`, `replace_candidates`, and `replace_compute`; its
  `path_excluded` (exclude-glob match + synthetic-child dir prune) is also
  the engine behind `project_config_service::dir_excluded`. Replace byte offsets
  are computed in the original string's byte space because Unicode case
  folding changes byte lengths. Cross-line patterns unsupported; columns
  are char counts; astral-plane matches can mis-highlight.
- `packages.rs` — `OnceLock<Arc<SystemPackages>>` singleton over typst's
  own package dirs (`%APPDATA%/typst/packages` data, `%LOCALAPPDATA%/typst/
  packages` cache on Windows).
- `package_index.rs` — Typst Universe `index.json` fetch/cache
  (`https://packages.typst.org/preview/index.json`, 16 MiB cap), cached at
  `<app-config>/typst-studio/cache/package-index.json` (written via
  `atomic::write_bytes` — a crash can't leave a torn cache).
- `downloader.rs` — reqwest+rustls `Downloader` impl for typst-kit (avoids
  ureq/openssl).
- `text_edits.rs` — apply LSP `TextEdit[]` (UTF-16 positions, applied
  back-to-front, overlapping edits refused) + `file_uri_to_path`.

## net

`client.rs` — shared `HttpClient`: 10-hop redirect policy, 30 s timeout,
50 MiB cap. `fetch.rs` — `fetch_bytes` / `fetch_to_file`: http(s)-only
scheme guard, streaming size cap, wall-clock deadline; destination
containment (workspace root or app config dir). The AI proxy
(`ipc/ai_commands.rs`) injects `ai.apiKey` server-side and enforces a
single-origin allowlist: the origin of `ai.baseUrl` (or the provider
default `https://api.anthropic.com` / `https://api.openai.com`); any other
host:port is refused.

## lsp (tinymist bridge)

- `manager.rs` — `LspManager`: WebSocket server on 127.0.0.1:0 with a
  4-dimension handshake (Origin allowlist, exact path `/lsp/main/<gen>`,
  generation, token); supervisor backoff 1→30 s. `restart` bumps the
  generation BEFORE superseding so stale URLs die at the upgrade;
  unsolicited relay end bumps generation (ChildCrash). Accept-loop
  failures back off 1/2/4/8/16/30 s then park until manual restart;
  relaunches start above the old generation because the frontend's status
  gate is forward-only.
- `relay.rs` — bidirectional WS ↔ stdio text-frame relay; one fresh
  `tinymist lsp` child per accepted connection (`kill_on_drop`,
  `CREATE_NO_WINDOW` on Windows, stderr drained to avoid pipe-block).
- `framing.rs` — `Content-Length` framing (CRLF enforced, 64 MiB cap).
- `installer.rs` — managed install into `~/.typststudio/` from GitHub
  releases (pinned tinymist version). Verify-before-extract: SHA-256
  against the release `sha256.sum` (3 attempts) BEFORE extraction;
  `--version` smoke test before committing the version marker (written
  atomically); every
  failure path removes unverified binaries and restores the parked `.old`.
  Discovery order: `lsp.tinymistPath` setting → `~/.typststudio/tinymist`
  → PATH. Uses a dedicated reqwest client with a stall-only read timeout
  (2 min) because the shared client must tolerate LLM responses pausing
  mid-stream.

## persistence

- `atomic.rs` — the atomic write used by everything: same-dir
  `.typst-tmp-<base>-<uuid>` temp → write → fsync → copy target perms →
  rename (Unix) / rename-then-remove+rename fallback (Windows; the failed
  fallback preserves the temp as the last copy) → best-effort dir fsync.
  Original untouched on pre-rename failure; stale temps >24 h cleaned at
  startup.
- `backup.rs` — `load_json_with_backup` / `write_with_backup`: `.bak` =
  last known-good, rotated only from successfully-read previous bytes;
  corrupt main quarantined to `*.corrupt-<ts>`, never deleted. The
  read→write→rotate sequence is not internally locked — concurrent writers
  to one path can leave `.bak` one generation stale (documented contract).
- `migrate.rs` — forward-only `Migrator` (ordered steps, clone-then-commit,
  never downgrades an ahead-of-current version; step failure leaves the
  value untouched).
- `recovery.rs` — `RecoveryService`: debounced dirty-buffer snapshots
  (750 ms quiescence, 2 s max) + clean-shutdown marker. Layout:
  `<app-data>/recovery/{manifest.json(+.bak), documents/<id>.json,
  clean-shutdown}`; a `discarded_since_queued` set prevents worker
  resurrection of discarded ids.

## settings

`manifest.rs` — typed view over the embedded `settings/manifest.json`
(single source of truth, also Vite-imported by the frontend). `store.rs` —
`JsonFileStore` (free-form JSON value, `.bak` fallback, schemaVersion
tag). `service.rs` — `SettingsService`: dotted-path get/set, manifest
validation, write lock, rollback, `on_change` broadcast to all windows.
`window.rs` — the standalone Settings window (`?window=settings`,
always-on-top, `settings_window` events). Manifest categories: editor,
appearance, compiler, data, preview, lsp, ai, keybindings, saving (~70
keys), plus readonly `window.recentWorkspaces` and `action.*` buttons.

## Support

`paths.rs` — `app_config_dir()` (`%APPDATA%/com.typststudio.app` and
platform equivalents) without an AppHandle. `diagnostics.rs` — two-phase
tracing init, daily-rotated logs (max 5). `error.rs` — `AppError`
serializing as structured `IpcError {code, message, details?, recoverable}`.

## Security invariants

- Logs carry only paths/ids/counts/outcomes — never document text, tokens,
  or request bodies; the LSP handshake logs token *presence* only.
- All fetches http(s)-only with destination containment; the AI proxy is
  single-origin with the key never crossing into the webview.
- WS handshake rejects bad origin/token (403) and bad path/generation
  (404); single-generation single-connection.
