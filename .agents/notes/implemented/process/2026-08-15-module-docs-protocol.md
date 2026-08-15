# Agent Note: Module docs with read-before / update-after protocol

Status: implemented

## Problem

AGENTS.md carries the rules but not the map: an agent starting work on,
say, `service/compile_worker.rs` or `appLanguageClient.ts` had to re-read
the whole subsystem from source every session, and the subsystem's
non-obvious invariants (revision guards, atomic-write protocol, LSP
generation rules) lived scattered across code comments with no single
per-module home. Knowledge existed but was expensive to re-acquire.

## Decision

`docs/modules/` holds one developer doc per module (10 docs:
architecture overview, frontend shell/extensions/components/state/lib,
backend layers/typst-engine/infra, build-and-testing), written in English
and sourced from a full read-through of the code with every claim tied to
a file path. AGENTS.md gained a "Documentation protocol" section: read the
covering module doc before developing; update it in the same PR when its
facts change (facts only — decisions and rationale still belong in Agent
Notes, not module docs).

## Alternatives considered

- Expand AGENTS.md with the module detail — violates the word budget;
  standing orders must stay scannable, detail belongs in linked homes.
- Generate docs from code (docgen) — generated prose goes stale silently
  and can't capture the invariants and gotchas that only reading
  comments and tests reveals.
- No module docs, rely on code comments — comments are local; a per-module
  map with cross-module flows (compile loop, save path, LSP relay) doesn't
  fit any single file.

## Consequences

Module docs are now part of the change surface: a PR that changes
documented behavior without touching the doc is incomplete, and reviewers
treat doc drift like test drift. The protocol is a standing order, not a
mechanical gate — "the doc's facts changed" is a semantic judgment, and
forcing a doc touch on every code commit would create noise edits; if
drift becomes a real problem, a doc-sync gate can be added later and this
note updated. Architecture-level decisions still require an Agent Note;
module docs carry facts, not rationale.
