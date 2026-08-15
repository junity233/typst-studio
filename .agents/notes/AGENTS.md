# Agent Notes — writing spec

Agent Notes are ADRs written by agents for agents and the human maintainer:
they record motivation, rejected alternatives, consequences, and the
verification a change needs. They are this repo's only long-term memory
across sessions — search this tree before designing anything non-trivial,
especially to avoid re-proposing a rejected alternative.

Format is enforced by `npm run agent:notes`
(`scripts/check_agent_repo.py notes --format-adopted 2026-08-15`); breaking
it fails pre-commit and CI.

## Directory & filename (path is metadata)

```
.agents/notes/
├── proposed/     proposals under review
├── implemented/  shipped; the Facts in these notes keep updating with code
├── rejected/     kept only when the rejection prevents re-litigation
└── archived/     read-only cold storage (implemented notes only)
```

Filename: `{lifecycle}/{class}/yyyy-mm-dd-kebab-title.md`. The date is the
first-proposal date and never changes. `class` is a closed set enforced by
the gate: `feature` / `bug-fix` / `simplification` / `architecture` /
`process` / `testing`. Architecture is about the source we ship; process is
the surrounding tooling.

## File format

The header is a strict 4-line block:

```markdown
# Agent Note: <title>
<blank>
Status: <status line>
<blank>
```

Status grammar per directory — `proposed/`: exactly `Status: proposed`;
`implemented/`: exactly `Status: implemented`; `rejected/`:
`Status: rejected — <one-line reason>`. The `Status:` line appears exactly
once in the file.

The first `##` section must be `## Problem`. Section skeletons:

- **proposed**: Problem / Proposal / Alternatives considered / Acceptance
  criteria / Risks
- **implemented**: Problem / Decision / Alternatives considered /
  Consequences — written in present tense as shipped reality. Proposal-era
  headings (`## Proposal`, `## Plan`, `## Migration plan`,
  `## Acceptance criteria`) are rejected by the gate in `implemented/`.
- **rejected**: Problem / Proposal / Alternatives considered

`## Alternatives considered` is always required. The grandfather comment
`<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->`
exists only for notes dated before 2026-08-15; new notes never use it —
we do not invent history.

Cross-reference other notes with relative markdown links only. Do not
generate index files — the directory tree is the index.

## Lifecycle rules

1. Every non-trivial PR carries at least one note in the same PR;
   mechanical/local edits are exempt.
2. When code renames or moves things, the same PR updates the Facts in the
   affected `implemented/` notes (facts only — decisions never change).
3. When a new note supersedes an old one, archive the old one in the same
   PR, adding a single `Archived: YYYY-MM-DD` line.
4. Changes to this notes system itself get a `process` note.
