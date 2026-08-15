#!/usr/bin/env python3
"""Gates for the gated-agent-dev paradigm. Stdlib only.

Usage:
  python check_agent_repo.py notes  [--root PATH] [--format-adopted YYYY-MM-DD]
  python check_agent_repo.py budget [--root PATH]

notes:  verifies the .agents/notes tree — lifecycle/class placement,
        filename dates, the 4-line header block, status grammar per
        lifecycle, section skeletons, the universal "## Alternatives
        considered" (or the exact grandfather comment for pre-format
        notes), and banned proposal-era headings in implemented/.
        Calibrated against deepseek-harness's verify-agent-note-format.ts.

budget: word-counts every AGENTS.md (excluding node_modules/.git/vendor)
        against .agents/doc-budgets.json ({"AGENTS.md": 1500, ...}, keys are
        repo-relative posix paths). Files without a manifest entry get the
        default limit (1500 for root, 800 otherwise).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

LIFECYCLES = {"proposed", "implemented", "rejected", "archived"}
CLASSES = {"feature", "bug-fix", "simplification", "architecture", "process", "testing"}
FNAME = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
TITLE = re.compile(r"^# Agent Note: \S")
STATUS_GRAMMAR = {
    "proposed": re.compile(r"^Status: proposed$"),
    "implemented": re.compile(r"^Status: implemented$"),
    "rejected": re.compile(r"^Status: rejected — .+$"),
}
REQUIRED = {
    "proposed": ["## Proposal", "## Acceptance criteria", "## Risks"],
    "implemented": ["## Decision", "## Consequences"],
    "rejected": ["## Proposal"],
}
BANNED_IMPLEMENTED = re.compile(
    r"^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)", re.IGNORECASE
)
GRANDFATHER = "<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->"
LEGACY_MARKERS = ("XXX: legacy ADR/RFC body format", "XXX: legacy ADR/Agent Note body format")
GOVERNANCE_NAMES = {"AGENTS.md", "README.md", "CLAUDE.md"}


def strip_fences(lines: list[str]) -> list[str]:
    """Format tokens inside fenced code blocks are not document structure."""
    out, in_fence = [], False
    for line in lines:
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return out


def check_notes(root: Path, format_adopted: str) -> tuple[list[str], int]:
    notes_dir = root / ".agents" / "notes"
    if not notes_dir.is_dir():
        return ([f"missing directory: {notes_dir}"], 0)
    errors: list[str] = []
    count = 0
    for md in sorted(notes_dir.rglob("*.md")):
        rel = md.relative_to(notes_dir)
        parts = rel.parts
        if parts[-1] in GOVERNANCE_NAMES:
            continue
        if not FNAME.match(parts[-1]):
            continue  # non-dated prose file: not a note, not our business
        count += 1
        if len(parts) != 3:
            errors.append(f"{rel.as_posix()}: expected <lifecycle>/<class>/<file>")
            continue
        lifecycle, klass, fname = parts
        if lifecycle not in LIFECYCLES:
            errors.append(f"{rel.as_posix()}: unknown lifecycle '{lifecycle}'")
            continue
        if klass not in CLASSES:
            errors.append(f"{rel.as_posix()}: unknown class '{klass}' (closed set: {sorted(CLASSES)})")
            continue
        note_date = fname[:10]
        fail = lambda msg: errors.append(f"{rel.as_posix()}: {msg}")  # noqa: E731
        try:
            raw = md.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            fail(f"unreadable ({exc})")
            continue
        prose = strip_fences(raw)

        if not TITLE.match(raw[0] if raw else ""):
            fail("line 1 must be `# Agent Note: <title>`")
            continue
        if len(raw) < 4 or raw[1] != "":
            fail("line 2 must be blank")
            continue
        grammar = STATUS_GRAMMAR.get(lifecycle)
        if grammar is not None:
            if len(raw) < 3 or not grammar.match(raw[2]):
                fail(f"line 3 must match the {lifecycle} status grammar ({grammar.pattern})")
                continue
            if raw[3] != "":
                fail("line 4 must be blank")
        status_lines = [l for l in prose if l.startswith("Status:")]
        if grammar is not None and len(status_lines) != 1:
            fail("the line-3 `Status:` line must be the only one in the file")

        h2s = [l.rstrip() for l in prose if l.startswith("## ")]
        if not h2s or h2s[0] != "## Problem":
            fail(f"the first section must be `## Problem` (got {h2s[0] if h2s else '<none>'!r})")
        for required in REQUIRED.get(lifecycle, []):
            if required not in h2s:
                fail(f"missing the required `{required}` section")
        if lifecycle == "implemented":
            for h2 in (h for h in h2s if BANNED_IMPLEMENTED.match(h)):
                fail(f"`{h2}` is a proposal-era heading; state what is (fold into Decision/Consequences)")

        has_section = "## Alternatives considered" in h2s
        has_grandfather = any(l.strip() == GRANDFATHER for l in prose)
        if has_section and has_grandfather:
            fail("carries both `## Alternatives considered` and the grandfather comment — drop the comment")
        if not has_section and not has_grandfather:
            fail("missing `## Alternatives considered` (pre-format notes carry the grandfather comment instead)")
        if has_grandfather and note_date >= format_adopted:
            fail(f"the grandfather comment is only valid for notes dated before {format_adopted}")

        if any(marker in l for l in prose for marker in LEGACY_MARKERS):
            fail("carries the retired legacy-format debt marker")
    return errors, count


def check_budget(root: Path) -> list[str]:
    manifest: dict[str, int] = {}
    manifest_path = root / ".agents" / "doc-budgets.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return [f"bad manifest {manifest_path}: {exc}"]
    errors: list[str] = []
    skip = {"node_modules", ".git", "vendor", ".agents"}
    candidates = [root / "AGENTS.md"] + [
        p for p in root.rglob("AGENTS.md")
        if not (set(p.relative_to(root).parts[:-1]) & skip)
    ]
    seen: set[Path] = set()
    for md in candidates:
        md = md.resolve()
        if md in seen or not md.is_file():
            continue
        seen.add(md)
        rel = md.relative_to(root).as_posix()
        words = len(md.read_text(encoding="utf-8").split())
        limit = manifest.get(rel, 1500 if rel == "AGENTS.md" else 800)
        mark = "ok" if words <= limit else "OVER"
        print(f"budget: {rel}: {words}/{limit} words [{mark}]")
        if words > limit:
            errors.append(f"{rel}: {words} words exceeds budget {limit}")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["notes", "budget"])
    ap.add_argument("--root", default=".", help="repository root (default: cwd)")
    ap.add_argument(
        "--format-adopted",
        default=dt.date.today().isoformat(),
        help="date the note format took effect; the grandfather comment is valid "
             "only for notes dated before it (default: today)",
    )
    args = ap.parse_args()
    root = Path(args.root).resolve()
    if args.command == "notes":
        errors, count = check_notes(root, args.format_adopted)
        if count == 0:
            errors.append(f"no dated notes found under {root / '.agents' / 'notes'}")
        else:
            print(f"notes: checked {count} notes")
    else:
        errors = check_budget(root)
    for err in errors:
        print(f"FAIL: {err}", file=sys.stderr)
    if errors:
        print(f"{args.command}: {len(errors)} error(s)", file=sys.stderr)
        return 1
    print(f"{args.command}: all gates green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
