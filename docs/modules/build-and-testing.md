# Build, tests, and gates

> Scope: `package.json`, `vite.config.ts`, `vitest.config.ts`,
> `scripts/*.mjs`, `scripts/check_agent_repo.py`, `lefthook.yml`,
> `.github/workflows/*`, `src-tauri` build features.

## Build chain (frontend)

- `npm run dev` / `build` first run `fetch-grammar` (downloads tinymist's
  VSIX from OpenVSX, extracts the TextMate grammar + language config +
  manifest slice into `src/assets/grammar/`, cached in
  `node_modules/.cache/grammar` for offline rebuilds) and
  `fetch-monaco-assets` (mirrors oniguruma WASM + theme JSONs into
  `public/vendor/`). Both outputs are **generated and gitignored** — `tsc`
  imports the grammar manifest, so a fresh clone fails typecheck until
  `fetch-grammar` has run. `npm run typecheck` wraps this
  (fetch-grammar + `tsc -b`).
- `vite.config.ts` gotchas (load-bearing, do not remove):
  - `optimizeDeps.exclude` for `@codingame/monaco-vscode-theme-defaults-default-extension`
    and `@codingame/monaco-vscode-textmate-service-override` — pre-bundling
    rewrites `import.meta.url` and 404s every JSON resource the packages
    register.
  - `resolve.dedupe: ["vscode"]` for monaco-languageclient.
  - Fixed dev port 1420 (`strictPort`), dev server fs allow-list pinned to
    the project root, `src-tauri` excluded from watching.
- `vite.config.js`/`.d.ts` and `*.tsbuildinfo` are gitignored because
  Vite resolves `.js` before `.ts` — never commit a built `vite.config.js`.

## Rust side

`src-tauri` is a Tauri v2 crate (`cargo` workspace root at `src-tauri/`).
The `export-types` feature enables ts-rs type-export tests:
`cargo test --features export-types` regenerates `src/lib/types.ts` — run
it whenever a `#[derive(TS)]` struct changes. Linux CI needs the GTK/
WebKit dev packages (see `.github/workflows/ci.yml`). Clippy runs without
`-D warnings` (one known warning sits in the frozen
`src-tauri/src/git/status.rs`).

## Tests

- Frontend: vitest, jsdom, `globals: false`, suites colocated as
  `src/**/__tests__/*.test.ts(x)`. `npm run test:run` is the full suite;
  run single files with `npx vitest run <file>` (the narrowest evidence for
  a diff). Real Monaco/WebSocket code can't run under jsdom — pure seams
  are deliberately split out for tests. Component/hook suites render
  through the shared `src/test/react.tsx` `reactHarness()` (createRoot +
  act + cleanup, sets IS_REACT_ACT_ENVIRONMENT). `src/lib/tauri.ts` emulates IPC
  in-browser for tests.
- Rust: `#[cfg(test)]` modules in-file plus `src-tauri/tests/`
  (e.g. `bib_yml_check.rs` pins bibliography parsing against
  `examples/bib-demo/` fixtures).
- Locale parity is a gate: `src/i18n/__tests__/keyParity.test.ts`.

## CI (`.github/workflows/`)

- `ci.yml` — on PR and push to master. Jobs: `agent-gates`
  (`python3 scripts/check_agent_repo.py notes|budget`, pinned
  `--format-adopted 2026-08-15`), `frontend` (fetch-grammar → `tsc -b` →
  `vitest run` → `npm run build` so every PR proves the tree still packs),
  `rust` (apt deps → clippy `--all-targets` → `cargo test`, with
  rust-cache).
- `release.yml` — tag-triggered installer builds.

## Local gates (lefthook, `lefthook.yml`)

`npm install` runs `prepare` → `lefthook install`. pre-commit stays under
~10 s: agent-note format gate, AGENTS.md word-budget gate, staged
whitespace check. pre-push runs `npm run typecheck` only — never the full
test suite locally; CI owns exhaustive coverage
(`.agents/notes/implemented/process/2026-08-15-gated-agent-development-bootstrap.md`).

## Agent infrastructure

- `AGENTS.md` — standing orders (word budget 1500, gated by
  `npm run agent:budget`); `CLAUDE.md` is a plain-copy mirror.
- `.agents/notes/` — Agent Notes (ADRs); format gate
  `npm run agent:notes`; writing spec in `.agents/notes/AGENTS.md`.
- `.agents/doc-budgets.json` — per-path AGENTS.md word budgets.
- `.agent/` — round-based workflow session state, gitignored; durable
  decisions belong in `.agents/notes/`, not here.

## Module docs protocol

`docs/modules/` holds one doc per module. Read the doc covering the files
you're about to touch before developing; update it in the same PR when the
facts it documents change (see AGENTS.md → Documentation protocol).
