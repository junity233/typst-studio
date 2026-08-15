# Typst Studio — Agent Standing Orders

Typst Studio is a Tauri v2 desktop IDE for Typst: a React 19 + TypeScript
frontend in `src/`, a Rust backend in `src-tauri/` embedding the official
Typst compiler (pinned 0.15). Every workbench feature ships as an in-tree
extension — contributions go through the extension API, never straight into
the shell.

## Frozen module

`src-tauri/src/git/**` is frozen by maintainer directive: do not edit,
refactor, or silence warnings there (origin recorded in the bootstrap note,
`.agents/notes/implemented/process/2026-08-15-gated-agent-development-bootstrap.md`).
CI runs clippy without `-D warnings` for exactly this reason.

## Repository layout

```
src/components/   React UI (Editor, Preview, Sidebar, Settings, …); tests colocated in __tests__/
src/extensions/   workbench features as in-tree extensions (<id>/index.ts default-exports activate(ctx))
src/hooks/        React hooks wiring Tauri events / IPC to stores
src/lib/          framework-free TS logic (htmlToTypst, pathMacros, viewerByteCache, …)
src/store/        zustand stores
src/i18n/         locales/{en,zh}/<ns>.json, picked up via import.meta.glob
src-tauri/src/
  domain/         pure types (some exported to TS via ts-rs, `export-types` feature)
  ipc/            Tauri command surface — thin parsing, delegates to service/
  service/        app services (compile supervisor, export, session, save coordinator, …)
  typst_engine/   compiler world / vfs / font loading
  render/         svg/pdf/png pipelines + source map
  fs/ net/ lsp/ persistence/ settings/   supporting infrastructure
  git/            FROZEN — see above
scripts/          fetch-grammar, fetch-monaco-assets, check_agent_repo.py
docs/             user-facing docs (typstpro, themes)
.agents/notes/    Agent Notes (ADRs) — search before designing anything non-trivial
.agent/           round-based agent session state — local-only, gitignored, never commit
```

## Commands

- `npm run tauri dev` # full app; `npm run dev` # frontend only
- `npm run typecheck` # fetch-grammar && tsc -b — the grammar manifest is
  generated and gitignored; tsc fails without it
- `npm run test:run` # full vitest suite (the CI gate; run single files locally)
- `npx vitest run src/lib/__tests__/<file>.test.ts` # narrowest evidence for a frontend diff
- `npm run build` # fetch assets + tsc -b + vite build
- `npm run agent:notes` / `npm run agent:budget` # note-format / AGENTS.md word-budget gates
- in `src-tauri/`: `cargo test`; `cargo clippy --all-targets`;
  `cargo test --features export-types` # regenerate ts-rs TypeScript types

Pick the narrowest evidence for your diff. Never default to the full suite
and never repeat a passing check — CI owns exhaustive coverage.

## Conventions

- **Every workbench feature is an extension** under `src/extensions/<id>/`
  whose `index.ts` default-exports `activate(ctx)`. Register views, commands,
  and menu items through `HostApi` (`src/extensions/api.ts`). One extension
  failing must not take down the app (activation loop in
  `src/extensions/index.ts`).
- **Non-trivial changes MUST include an Agent Note in the same PR.** Only
  mechanical/local edits are exempt. Writing spec: `.agents/notes/AGENTS.md`.
- **User-visible strings go through i18n, in BOTH locales.** Add the key to
  `locales/en/<ns>.json` and `locales/zh/<ns>.json`; parity is gated by
  `src/i18n/__tests__/keyParity.test.ts`.
- **Micro-commits**: `type(scope): imperative subject`, ≤72 chars, one
  concern per commit; keep fix / refactor / test / docs separate.
- **Model-visible or user-visible behavior ⟺ a pinning test in the same PR**
  (vitest, colocated `__tests__/`; Rust, `#[cfg(test)]` in-module).
- **Wire mechanically checkable invariants into an executed gate.** Prose
  that no command enforces does not exist.
- **Misconfiguration fails loud** — surface a dialog or an error, never
  silently degrade.
- Don't touch `vite.config.ts` `optimizeDeps.exclude` for `@codingame/*`
  packages (Monaco resources break; rationale in that file).

## Defensive patterns

- Windows canonicalized paths carry the `\\?\` verbatim prefix; the backend
  strips it with `dunce::simplified`. Never reintroduce prefix handling on
  the frontend (rationale in `src-tauri/Cargo.toml`).
- Dependency rationale (version pins, dedupe notes, feature flags) lives as
  inline comments in `src-tauri/Cargo.toml` next to each dependency — read
  them before adding, bumping, or removing one.

## Editing this file

`AGENTS.md` is the source of truth; `CLAUDE.md` is a plain-copy mirror
(no symlinks on Windows). Edit here, then copy over. Word budget: 1500,
gated by `npm run agent:budget`.
