/**
 * Pure text-diff utilities for the side-by-side compare views (conflict
 * resolution + crash recovery dialogs, §5.1.3 / §5.4).
 *
 * Two layers:
 *
 *   1. **Line diff** — LCS over lines (after trimming the common prefix and
 *      suffix, which keeps the LCS table small for the usual "big file, small
 *      edit" case). Produces equal / del / add runs.
 *   2. **Word diff** — the same LCS core over whitespace-separated tokens,
 *      used to highlight the *words* that differ inside a paired changed line.
 *
 * Everything here is synchronous and allocation-bounded: inputs whose changed
 * middle exceeds `MAX_LCS_CELLS` fall back to a coarse prefix/suffix diff
 * (still correct, just without intra-block alignment), so a pathological
 * compare can never hang the dialog.
 */

/**
 * Hard cap on the LCS DP table (in cells). Beyond this the line diff degrades
 * to the coarse fallback. 4M cells ≈ a 2000×2000-line fully rewritten middle —
 * far beyond realistic compare dialogs — while keeping the table at 16 MB.
 */
const MAX_LCS_CELLS = 4_000_000;

/** Same cap for the word-level LCS (tokens-per-line is small; generous). */
const MAX_WORD_CELLS = 250_000;

/** A run of the edit script. */
interface LcsOp {
  op: "equal" | "del" | "add";
  count: number;
}

/**
 * Map the strings of BOTH sides through ONE shared table, so a string
 * present on both sides gets the same id — equality of ids is then equality
 * of the original strings, which is what the LCS compares. (Interning each
 * side separately would number their strings independently and make every
 * position compare "equal".)
 */
function internBoth(
  a: readonly string[],
  b: readonly string[],
): { ai: Int32Array; bi: Int32Array } {
  const ids = new Map<string, number>();
  const map = (parts: readonly string[]) => {
    const out = new Int32Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i];
      let id = ids.get(s);
      if (id === undefined) {
        id = ids.size;
        ids.set(s, id);
      }
      out[i] = id;
    }
    return out;
  };
  return { ai: map(a), bi: map(b) };
}

/**
 * LCS edit script between two interned id arrays, as coalesced
 * equal/del/add runs. Returns `null` when the DP table would exceed
 * `maxCells` (caller falls back to the coarse diff).
 *
 * Classic lengths-table DP with backtrack from (n, m). Backtracking emits ops
 * in reverse, so runs are prepended and the list flipped at the end.
 */
function lcsOps(
  sides: { ai: Int32Array; bi: Int32Array },
  maxCells: number,
): LcsOp[] | null {
  const a = sides.ai;
  const b = sides.bi;
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > maxCells) return null;

  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    const av = a[i - 1];
    const row = i * w;
    const prev = row - w;
    for (let j = 1; j <= m; j++) {
      table[row + j] =
        av === b[j - 1]
          ? table[prev + j - 1] + 1
          : Math.max(table[prev + j], table[row + j - 1]);
    }
  }

  const reversed: LcsOp[] = [];
  const push = (op: "equal" | "del" | "add") => {
    const head = reversed[reversed.length - 1];
    if (head !== undefined && head.op === op) {
      head.count++;
    } else {
      reversed.push({ op, count: 1 });
    }
  };

  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      push("equal");
      i--;
      j--;
    } else if (table[(i - 1) * w + j] >= table[i * w + (j - 1)]) {
      push("del");
      i--;
    } else {
      push("add");
      j--;
    }
  }
  while (i > 0) {
    push("del");
    i--;
  }
  while (j > 0) {
    push("add");
    j--;
  }
  reversed.reverse();
  return normalizeChangeBlocks(reversed);
}

/**
 * Reorder each maximal del/add block (no equal op between) to all-dels-then-
 * all-adds. Backtracking can interleave (`add, del, add`), which would defeat
 * the side-by-side pairing that expects a del run directly followed by an add
 * run. Del-first is also what git-style diffs render.
 */
function normalizeChangeBlocks(ops: LcsOp[]): LcsOp[] {
  const out: LcsOp[] = [];
  let del = 0;
  let add = 0;
  const flush = () => {
    if (del > 0) out.push({ op: "del", count: del });
    if (add > 0) out.push({ op: "add", count: add });
    del = 0;
    add = 0;
  };
  for (const { op, count } of ops) {
    if (op === "equal") {
      flush();
      out.push({ op, count });
    } else if (op === "del") {
      del += count;
    } else {
      add += count;
    }
  }
  flush();
  return out;
}

/**
 * Coarse fallback when the precise LCS is too big: everything between the
 * common prefix and suffix is one del block + one add block. Correct (the
 * equal runs at both ends are genuinely equal), just without alignment inside
 * the rewritten middle.
 */
function coarseOps(
  a: readonly string[],
  b: readonly string[],
): { ops: LcsOp[]; prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ops: LcsOp[] = [];
  if (prefix > 0) ops.push({ op: "equal", count: prefix });
  const delCount = a.length - prefix - suffix;
  const addCount = b.length - prefix - suffix;
  if (delCount > 0) ops.push({ op: "del", count: delCount });
  if (addCount > 0) ops.push({ op: "add", count: addCount });
  if (suffix > 0) ops.push({ op: "equal", count: suffix });
  return { ops, prefix, suffix };
}

/**
 * Split into lines, treating the empty string as ZERO lines (git semantics)
 * — `"".split("\n")` would yield one phantom empty line, so diffing an empty
 * file against content would show a spurious empty deletion. A trailing
 * newline ("a\n" → ["a", ""]) stays meaningful.
 */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * Line-level diff of `a` vs `b`, precise via LCS (prefix/suffix trimmed
 * first), coarse above the cell cap. Returns the edit script as runs.
 */
function lineOps(a: readonly string[], b: readonly string[]): LcsOp[] {
  // Trim the common prefix/suffix before the DP so a small edit inside a long
  // document never allocates the big table.
  const { ops: trimmed, prefix, suffix } = coarseOps(a, b);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) {
    return trimmed; // identical (or prefix/suffix-covered) inputs
  }
  const precise = lcsOps(internBoth(midA, midB), MAX_LCS_CELLS);
  if (precise !== null) {
    // Re-attach the trimmed equal runs — the precise ops cover only the
    // changed middle.
    const ops: LcsOp[] = [];
    if (prefix > 0) ops.push({ op: "equal", count: prefix });
    ops.push(...precise);
    if (suffix > 0) ops.push({ op: "equal", count: suffix });
    return ops;
  }
  // Too big for the DP table — the trimmed prefix/suffix ops ARE the coarse
  // diff (del-middle + add-middle), which is exactly the fallback we want.
  return trimmed;
}

// ---------------------------------------------------------------------------
// Word-level diff (intra-line)
// ---------------------------------------------------------------------------

/** One emphasized segment of a paired changed line. */
export interface TokenSpan {
  text: string;
  /** `same` renders plain; `del` exists only on the left; `add` only on the right. */
  emphasis: "same" | "del" | "add";
}

/** Word-diff result: the left pane gets same+del spans, the right same+add. */
export interface WordDiff {
  left: TokenSpan[];
  right: TokenSpan[];
}

/**
 * Split a line into word/whitespace tokens. Whitespace runs are kept as their
 * own tokens so spacing differences are visible in the highlight (and so
 * concatenating the tokens reproduces the line exactly).
 */
function tokenize(line: string): string[] {
  return line.split(/(\s+)/).filter((t) => t !== "");
}

/**
 * Word-level diff between two paired lines. Returns `null` when the token
 * product exceeds the word cap (absurdly long lines) — the caller degrades to
 * whole-line emphasis.
 */
export function wordDiff(a: string, b: string): WordDiff | null {
  const at = tokenize(a);
  const bt = tokenize(b);
  if (at.length * bt.length > MAX_WORD_CELLS) return null;

  const ops =
    lcsOps(internBoth(at, bt), MAX_WORD_CELLS) ?? coarseOps(at, bt).ops;

  const left: TokenSpan[] = [];
  const right: TokenSpan[] = [];
  let ai = 0;
  let bi = 0;
  const emit = (arr: TokenSpan[], text: string, emphasis: TokenSpan["emphasis"]) => {
    const last = arr[arr.length - 1];
    if (last !== undefined && last.emphasis === emphasis) {
      last.text += text;
    } else {
      arr.push({ text, emphasis });
    }
  };
  for (const { op, count } of ops) {
    if (op === "equal") {
      for (let k = 0; k < count; k++) {
        emit(left, at[ai], "same");
        emit(right, bt[bi], "same");
        ai++;
        bi++;
      }
    } else if (op === "del") {
      for (let k = 0; k < count; k++) {
        emit(left, at[ai], "del");
        ai++;
      }
    } else {
      for (let k = 0; k < count; k++) {
        emit(right, bt[bi], "add");
        bi++;
      }
    }
  }
  return { left, right };
}

// ---------------------------------------------------------------------------
// Side-by-side row model
// ---------------------------------------------------------------------------

/**
 * One row of the side-by-side view.
 *
 *   - `equal`  — identical line on both sides (rendered twice).
 *   - `pair`   — a deleted and an added line aligned for word-level diff.
 *   - `del`    — line present only on the left.
 *   - `add`    — line present only on the right.
 *   - `gap`    — a collapsed run of `count` consecutive equal lines.
 */
export type DiffRow =
  | { kind: "equal"; text: string }
  | { kind: "pair"; left: TokenSpan[]; right: TokenSpan[] }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string }
  | { kind: "gap"; count: number };

export interface SideBySideOptions {
  /** Equal lines kept adjacent to each change before collapsing. Default 3. */
  context?: number;
  /** Minimum number of hidden lines for a gap to be worth collapsing. Default 4. */
  minGap?: number;
}

/**
 * Build the side-by-side diff rows for `left` vs `right`.
 *
 * Equal runs longer than `2 * context + minGap` are collapsed into a `gap`
 * row (with `context` lines kept at each end), so every change stays visible
 * without scrolling through hundreds of unchanged lines.
 */
export function sideBySideDiff(
  left: string,
  right: string,
  options: SideBySideOptions = {},
): DiffRow[] {
  const context = options.context ?? 3;
  const minGap = options.minGap ?? 4;

  const a = splitLines(left);
  const b = splitLines(right);
  const ops = lineOps(a, b);

  // First pass: op runs → rows (no collapsing yet). Adjacent del+add runs are
  // paired line-by-line (up to the shorter run) so their word-level changes
  // line up horizontally; leftovers stay standalone del/add rows.
  const raw: DiffRow[] = [];
  let ai = 0;
  let bi = 0;
  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const { op, count } = ops[opIndex];
    if (op === "equal") {
      for (let k = 0; k < count; k++) {
        raw.push({ kind: "equal", text: a[ai] });
        ai++;
        bi++;
      }
      continue;
    }
    if (op !== "del") {
      for (let k = 0; k < count; k++) {
        raw.push({ kind: "add", text: b[bi] });
        bi++;
      }
      continue;
    }
    // del run — pair it with a directly following add run.
    const next = ops[opIndex + 1];
    const pairCount =
      next !== undefined && next.op === "add"
        ? Math.min(count, next.count)
        : 0;
    for (let k = 0; k < pairCount; k++) {
      const wd = wordDiff(a[ai], b[bi]);
      raw.push(
        wd !== null
          ? { kind: "pair", left: wd.left, right: wd.right }
          : // Absurdly long lines — degrade to whole-line emphasis.
            {
              kind: "pair",
              left: [{ text: a[ai], emphasis: "del" }],
              right: [{ text: b[bi], emphasis: "add" }],
            },
      );
      ai++;
      bi++;
    }
    for (let k = pairCount; k < count; k++) {
      raw.push({ kind: "del", text: a[ai] });
      ai++;
    }
    if (pairCount > 0 && next !== undefined && next.op === "add") {
      // Consume the paired prefix of the add run here; the remainder of the
      // run is handled by advancing opIndex past it below.
      for (let k = pairCount; k < next.count; k++) {
        raw.push({ kind: "add", text: b[bi] });
        bi++;
      }
      opIndex++; // the add run is fully consumed
    }
  }

  // Second pass: collapse long equal runs. A run between two changes keeps
  // `context` lines at each end; a run at the very start/end of the document
  // keeps only the end adjacent to a change.
  const out: DiffRow[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].kind !== "equal") {
      out.push(raw[i]);
      i++;
      continue;
    }
    let end = i;
    while (end < raw.length && raw[end].kind === "equal") end++;
    const runLen = end - i;
    const hasPrev = out.length > 0;
    const hasNext = end < raw.length;
    const headKeep = hasPrev ? context : 0;
    const tailKeep = hasNext ? context : 0;
    if (runLen > headKeep + tailKeep + minGap) {
      for (let k = 0; k < headKeep; k++) out.push(raw[i + k]);
      out.push({ kind: "gap", count: runLen - headKeep - tailKeep });
      for (let k = 0; k < tailKeep; k++) out.push(raw[end - tailKeep + k]);
    } else {
      for (let k = i; k < end; k++) out.push(raw[k]);
    }
    i = end;
  }
  return out;
}

/** Whether a diff contains any del/add/pair row (i.e. the texts differ). */
export function hasChanges(rows: readonly DiffRow[]): boolean {
  return rows.some((r) => r.kind !== "equal" && r.kind !== "gap");
}

// ---------------------------------------------------------------------------
// Unified (single-column) diff
// ---------------------------------------------------------------------------

/** One line of a unified diff (git-style single-column view). */
export interface UnifiedLine {
  kind: "ctx" | "del" | "add";
  text: string;
  /** 1-based line number in the original; -1 for pure additions. */
  beforeLine: number;
  /** 1-based line number in the revised; -1 for pure deletions. */
  afterLine: number;
}

/**
 * Unified diff of `before` vs `after` — the whole file as ctx/del/add lines,
 * no context collapsing (callers trim with their own window). Within each
 * change block del lines precede add lines (normalizeChangeBlocks ordering),
 * the convention git-style diffs render.
 */
export function unifiedDiff(before: string, after: string): UnifiedLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lineOps(a, b);
  const out: UnifiedLine[] = [];
  let ai = 0;
  let bi = 0;
  for (const { op, count } of ops) {
    if (op === "equal") {
      for (let k = 0; k < count; k++) {
        out.push({
          kind: "ctx",
          text: a[ai],
          beforeLine: ai + 1,
          afterLine: bi + 1,
        });
        ai++;
        bi++;
      }
    } else if (op === "del") {
      for (let k = 0; k < count; k++) {
        out.push({ kind: "del", text: a[ai], beforeLine: ai + 1, afterLine: -1 });
        ai++;
      }
    } else {
      for (let k = 0; k < count; k++) {
        out.push({ kind: "add", text: b[bi], beforeLine: -1, afterLine: bi + 1 });
        bi++;
      }
    }
  }
  return out;
}
