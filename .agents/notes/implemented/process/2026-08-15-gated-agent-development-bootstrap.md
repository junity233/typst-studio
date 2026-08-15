# Agent Note: Adopt gated agent development

Status: implemented

## Problem

Eight rounds of agent-driven improvement produced plans, dev summaries, and
review reports under `.agent/round-N/` — untracked session state. Standing
constraints lived in `.agent/state.json` (notably the maintainer's freeze on
`src-tauri/src/git/**`), invisible to any later session that didn't read
that file. There was no root AGENTS.md, so every session re-derived repo
rules, and real conventions (conventional commits, colocated tests,
en/zh locale parity) existed only as unenforced habits.

## Decision

The repo runs the gated-agent-dev paradigm in four layers:

- Standing orders in a word-budgeted root `AGENTS.md` (mirror: `CLAUDE.md`
  as a plain copy, since Windows can't symlink); the maintainer's git-module
  freeze became a rule there instead of session state.
- Knowledge in `.agents/notes/` (this ADR system) — `.agent/` remains
  local-only round workflow state, gitignored.
- Mechanical gates: `scripts/check_agent_repo.py` (`notes` + `budget`)
  runs in pre-commit (lefthook) and CI; locale key parity is gated by
  `src/i18n/__tests__/keyParity.test.ts` instead of prose.
- Operating rhythm: minimal evidence per diff, micro-commits, one note per
  non-trivial PR (rules in the root AGENTS.md).

## Alternatives considered

- Keep knowledge in `.agent/` round files — session-scoped, untracked, and
  unstructured; nothing stops a later round from contradicting an earlier
  rejection.
- Rely on inline code comments alone (the Cargo.toml style) — good for
  dependency rationale but has no lifecycle, no rejected alternatives, and
  no gate can enforce it.
- A full docs site — high upkeep; standing orders must stay small enough
  to inject into every session.

## Consequences

Every non-trivial PR now needs a note, and pre-commit runs the notes and
budget gates (seconds). The freeze on `src-tauri/src/git/**` and the
clippy-without-`-D warnings` rationale are recorded decisions
(see the clippy note in this directory) rather than comments pointing at
untracked round plans. Human review focuses on evidence selection and
semantics; mechanical correctness belongs to the gates.
