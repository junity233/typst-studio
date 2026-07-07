import type { CommandContribution } from "../../extensions/registry";

/**
 * A small fuzzy matcher for the Command Palette. ~20 commands, so this stays
 * deliberately simple: case-insensitive subsequence matching against the
 * command's `title` and (if present) `category`, with a score that rewards:
 *   - matches at word boundaries (after a space or at the start),
 *   - contiguous runs of matched characters,
 *   - matches appearing earlier in the string,
 *   - a title match over a category match.
 *
 * Returns 0 (or negative) for "no match"; the score is otherwise positive and
 * higher means a better match. `filterAndSort` drops non-matches and sorts by
 * score descending (ties broken by title length, then alphabetically, so a
 * shorter, exact title wins over a longer one).
 */

/** A penalty subtracted for each character between two consecutive matches. */
const GAP_PENALTY = 1;
/** A bonus added when a match begins at a word boundary (start or post-space). */
const WORD_BOUNDARY_BONUS = 8;
/** A bonus added for each contiguous character beyond the first in a run. */
const CONTIGUOUS_BONUS = 4;
/** A bonus applied to the whole score when the match is in the title. */
const TITLE_FIELD_WEIGHT = 2;

/**
 * Score `query` against `haystack` as a case-insensitive subsequence.
 * Returns 0 when `query` is not a subsequence (or haystack is empty), else a
 * positive number. Empty query is treated as "match all" and scores 0 — call
 * sites only treat 0-or-negative as "no match", but `filterAndSort` special-cases
 * the empty query to return everything, so the 0 here is unambiguous for that
 * path.
 */
function scoreField(query: string, haystack: string): number {
  if (haystack.length === 0) return 0;
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();

  let score = 0;
  let qi = 0;
  let prevMatchIndex = -1;
  let lastMatchIndex = -1;
  for (let hi = 0; hi < h.length && qi < q.length; hi++) {
    if (h[hi] === q[qi]) {
      // Word-boundary bonus: match at the very start, or right after a space.
      const atBoundary = hi === 0 || h[hi - 1] === " ";
      if (atBoundary) score += WORD_BOUNDARY_BONUS;
      // Contiguity bonus: every matched char beyond the first in a run.
      if (prevMatchIndex === hi - 1) score += CONTIGUOUS_BONUS;
      // Earlier matches score higher — subtract the position so index 0 wins.
      score -= hi;
      // Gap penalty: penalize the number of skipped chars since the last match.
      if (prevMatchIndex !== -1) {
        score -= (hi - prevMatchIndex - 1) * GAP_PENALTY;
      }
      prevMatchIndex = hi;
      lastMatchIndex = hi;
      qi++;
    }
  }
  if (qi < q.length) return 0; // query not fully consumed → not a subsequence
  // Coverage penalty: an unmatched tail of the haystack means the query is only
  // a partial match. This makes a query that fully covers a short title ("save"
  // → "Save") outrank the same prefix match in a longer title ("save" → "Save
  // As"), which is the prefix-vs-mid-word distinction the palette cares about.
  score -= Math.max(0, h.length - 1 - lastMatchIndex);
  // A pure-subsequence match with no bonuses (all gaps, last char) can dip
  // slightly negative; clamp to 1 so it still ranks above "no match" (0).
  return Math.max(1, score);
}

/**
 * Score a command against a query. Matches the title (preferred) and the
 * category; the higher of the two wins. Returns 0 (no match) or a positive
 * number. An empty query matches every command with a flat score of 0.
 */
export function scoreCommand(
  query: string,
  command: CommandContribution,
): number {
  const trimmed = query.trim();
  if (trimmed === "") return 0;
  const titleScore = scoreField(trimmed, command.title) * TITLE_FIELD_WEIGHT;
  const categoryScore = command.category
    ? scoreField(trimmed, command.category)
    : 0;
  return Math.max(titleScore, categoryScore);
}

/**
 * Filter `commands` by `query` and return them sorted best-match-first.
 * - Empty query → all commands, in their existing (registry) order.
 * - Otherwise → only commands with a positive score, descending by score;
 *   ties broken by shorter title, then by title alphabetically (stable).
 */
export function filterAndSort(
  query: string,
  commands: CommandContribution[],
): CommandContribution[] {
  const trimmed = query.trim();
  if (trimmed === "") return commands;
  const scored = commands
    .map((command) => ({ command, score: scoreCommand(trimmed, command) }))
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.command.title.length !== b.command.title.length) {
      return a.command.title.length - b.command.title.length;
    }
    return a.command.title.localeCompare(b.command.title);
  });
  return scored.map((entry) => entry.command);
}
