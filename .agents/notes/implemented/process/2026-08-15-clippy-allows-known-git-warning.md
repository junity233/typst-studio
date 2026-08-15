# Agent Note: Clippy runs without -D warnings

Status: implemented

## Problem

CI runs `cargo clippy --all-targets` without `-D warnings`
(`.github/workflows/ci.yml`). The reason lived in a CI comment pointing at
untracked round plans, so every future session would re-litigate whether
strictness should be turned on.

## Decision

Clippy stays advisory (no `-D warnings`) because the single known warning
sits in `src-tauri/src/git/status.rs`, and that module is frozen by
maintainer directive — see the
[bootstrap note](2026-08-15-gated-agent-development-bootstrap.md) for the
freeze's origin. Flipping to `-D warnings` would force editing the frozen
module, which the freeze forbids.

## Alternatives considered

- `cargo clippy -- -D warnings` plus a targeted `#[allow]` at the warning
  site — requires editing a file inside the frozen `src-tauri/src/git/**`
  tree.
- `#[allow(clippy::all)]` on the whole git module — same problem, and it
  would also mask future genuine warnings there.
- `-D warnings` only for non-git targets — cargo has no per-path lint
  switch; the workaround (separate crates) is an architecture change
  out of proportion to one warning.

## Consequences

New warnings in unfrozen code do not fail CI either; reviewers and agents
must actually read clippy output. When the maintainer lifts the freeze or
the `status.rs` warning is otherwise resolved, flip CI to
`cargo clippy --all-targets -- -D warnings` and update this note's facts in
the same PR.
