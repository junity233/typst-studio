import type * as Monaco from "@codingame/monaco-vscode-editor-api";

/**
 * Pure edit seam for `MonacoEditor.tsx`'s `MonacoEditorApi.wrapSelection` /
 * `replaceSelection` / `toggleLinePrefix` (Format Toolbar Task 1).
 *
 * `MonacoEditor` cannot be integration-tested under vitest+jsdom (Monaco
 * workers + widget CSS), so — following the precedent of
 * [`editorModelSync`](./editorModelSync.ts) — the text-edit logic lives here as
 * plain functions that take an editor and the component stays a thin
 * dispatcher. Each helper owns no React state; it reads the live selection,
 * fires edits through `editor.executeEdits` (matching the
 * [`usePasteConvert`](./usePasteConvert.ts) precedent), frames the change with
 * undo stops, and re-selects the resulting range so the component layer is
 * trivial.
 *
 * ## The `EditEditor` surface
 *
 * The helpers only touch a tiny slice of `IStandaloneCodeEditor`. We type
 * them against the minimal [`EditEditor`](#EditEditor) interface below so the
 * in-memory fake editor in `__tests__/editorEdit.test.ts` can implement that
 * slice directly — no `as unknown as` casts, and the tests verify real
 * behavior instead of spying on call sites. The live `IStandaloneCodeEditor`
 * satisfies `EditEditor` structurally, so `MonacoEditor.tsx` passes it in with
 * no adapter.
 *
 * Column convention (Monaco): columns are 1-based. Column 1 is *before* the
 * first char on a line; column N is *after* the (N-1)th char. A collapsed
 * caret has `selectionStartColumn === positionColumn`.
 */

/** Default placeholder inserted/selected by `applyWrapSelection` for an empty selection. */
const DEFAULT_PLACEHOLDER = "text";

/**
 * The minimal model surface the helpers read. A real
 * `Monaco.editor.ITextModel` satisfies this structurally.
 */
export interface EditModel {
  getLineContent(lineNumber: number): string;
  getLineMaxColumn(lineNumber: number): number;
  getValueInRange(range: Monaco.IRange): string;
  getValue(): string;
}

/**
 * The minimal editor surface the helpers use. A real
 * `Monaco.editor.IStandaloneCodeEditor` satisfies this structurally; the test
 * fake implements exactly this. `getSelection` returns the ISelection shape
 * (the helpers never need the richer `Selection` class).
 */
export interface EditEditor {
  getModel(): EditModel | null;
  getSelection(): Monaco.ISelection | null;
  setSelection(sel: Monaco.IRange): void;
  executeEdits(
    source: string | null | undefined,
    edits: Monaco.editor.IIdentifiedSingleEditOperation[],
  ): boolean;
  pushUndoStop(): boolean;
  focus(): void;
}

/**
 * Known Typst line-prefix markers this editor toggles. A run of one or more
 * `=` followed by a single space (headings `=`, `==`, `===`, …), `- ` (bullet),
 * `+ ` (numbered), or `> ` (block quote). Capture group 1 is the matched prefix
 * (without needing to know which alternative fired).
 *
 * Note the trailing space is part of the prefix: `=Hello` (no space) is NOT a
 * heading and must not be stripped — that's the user's literal text.
 */
const LINE_PREFIX_RE = /^(=+ |- |\+ |> )/;

/**
 * Wrap the current selection (or insert a placeholder when empty) with
 * `prefix` / `suffix`. Used for inline markup like `*…*`, `_…_`, `` `…` ``.
 *
 * - **Empty selection (collapsed caret):** insert `prefix + placeholder + suffix`
 *   at the caret and select the placeholder range so the user can immediately
 *   type over it.
 * - **Non-empty selection:** replace the selection with
 *   `prefix + selectedText + suffix` and leave the selection covering the
 *   whole wrapped span (`prefix + selectedText + suffix`) so one stroke deletes
 *   the markup too.
 *
 * The edit is framed with undo stops before and after, and the editor is
 * focused at the end so the new selection takes effect for typing.
 *
 * @param editor      The live Monaco editor.
 * @param prefix      Markup to insert before the selection/placeholder.
 * @param suffix      Markup to insert after.
 * @param placeholder Text to insert when the selection is empty (default
 *   `"text"`). Ignored when the selection is non-empty.
 */
export function applyWrapSelection(
  editor: EditEditor,
  prefix: string,
  suffix: string,
  placeholder: string = DEFAULT_PLACEHOLDER,
): void {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;

  // Normalize to document order (start ≤ end). Monaco tolerates reversed
  // ranges in executeEdits/getValueInRange, but the post-edit selection math
  // below needs document-order anchors to highlight the right span — without
  // this, a right-to-left selection would leave the highlight in the wrong
  // place after the wrap.
  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const startCol = columnAtStart(sel, startLine);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endCol = columnAtEnd(sel, endLine);

  const collapsed = startLine === endLine && startCol === endCol;

  const range: Monaco.IRange = {
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: endLine,
    endColumn: endCol,
  };

  let insertText: string;
  /** Selection to set after the edit: [startLine, startCol] → [endLine, endCol]. */
  let afterStart: { line: number; col: number };
  let afterEnd: { line: number; col: number };

  if (collapsed) {
    insertText = prefix + placeholder + suffix;
    // Placeholder sits at caret + prefix.length … caret + prefix.length + placeholder.length.
    afterStart = {
      line: startLine,
      col: startCol + prefix.length,
    };
    afterEnd = {
      line: afterStart.line,
      col: afterStart.col + placeholder.length,
    };
  } else {
    const selectedText = model.getValueInRange(range);
    insertText = prefix + selectedText + suffix;
    // Selection covers prefix + selected + suffix.
    afterStart = { line: startLine, col: startCol };
    afterEnd = computeEndAfterInsert(startLine, startCol, insertText);
  }

  editor.pushUndoStop();
  editor.executeEdits("format-wrap", [{ range, text: insertText }]);
  editor.setSelection({
    startLineNumber: afterStart.line,
    startColumn: afterStart.col,
    endLineNumber: afterEnd.line,
    endColumn: afterEnd.col,
  });
  editor.pushUndoStop();
  editor.focus();
}

/**
 * Replace the current selection with `text`, then select the full inserted
 * range. Used for block snippets (code block, HR, image, table) where we drop
 * in a chunk rather than wrap existing text. If the selection is empty, this
 * inserts at the caret. Framed with undo stops and focused.
 *
 * @param editor The live Monaco editor.
 * @param text   The text to drop in (may contain newlines; may be empty to
 *   emulate a delete).
 */
export function applyReplaceSelection(
  editor: EditEditor,
  text: string,
): void {
  const sel = editor.getSelection();
  if (!sel) return;

  // Normalize to document order so the post-edit selection covers the inserted
  // text regardless of which direction the user dragged. (See applyWrapSelection
  // for the rationale; applyToggleLinePrefix already normalizes via min/max.)
  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const startCol = columnAtStart(sel, startLine);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endCol = columnAtEnd(sel, endLine);

  const range: Monaco.IRange = {
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: endLine,
    endColumn: endCol,
  };

  const end = computeEndAfterInsert(startLine, startCol, text);

  editor.pushUndoStop();
  editor.executeEdits("format-replace", [{ range, text }]);
  editor.setSelection({
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: end.line,
    endColumn: end.col,
  });
  editor.pushUndoStop();
  editor.focus();
}

/**
 * Read the currently-selected text. Returns `""` for a collapsed caret or when
 * there's no model/selection. Used by the format toolbar's link flow (spec
 * §5.3) to pre-fill the link label with the selection and to decide whether to
 * wrap or replace. Pure: takes the editor, reads once, no edits.
 *
 * @param editor The live Monaco editor.
 * @returns The selected text, or `""` when nothing is selected.
 */
export function getSelectionText(editor: EditEditor): string {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return "";

  // Normalize to document order. Real Monaco's `getValueInRange` already
  // normalizes reversed ranges (its `Range` constructor swaps start/end when
  // start > end), so this is belt-and-suspenders — defensive in case the
  // editor surface ever changes, and keeps this read path symmetric with the
  // edit paths (applyWrapSelection/applyReplaceSelection), which genuinely
  // need the normalization for their post-edit selection math.
  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const range: Monaco.IRange = {
    startLineNumber: startLine,
    startColumn: columnAtStart(sel, startLine),
    endLineNumber: endLine,
    endColumn: columnAtEnd(sel, endLine),
  };
  return model.getValueInRange(range);
}

/**
 * Idempotent wrap toggle: if the selection/caret already sits inside a
 * `prefix…suffix` region, **unwrap** it (replace the full `prefix…suffix` span
 * with the inner text and select the inner text); otherwise **wrap** it
 * (delegating to {@link applyWrapSelection}). Used by the format toolbar's
 * bold/italic/code/strikethrough/quote buttons (state-aware toolbar T1).
 *
 * - **Non-empty selection:** if the selected text itself starts with `prefix`
 *   and ends with `suffix` (and is long enough to contain both markers), unwrap
 *   to the inner text; otherwise wrap the selection.
 * - **Collapsed caret:** scan the caret's line (single-line only) via
 *   {@link findEnclosingWrap} for the nearest enclosing `prefix…suffix` pair.
 *   If found, unwrap that pair; if not, insert a `prefix + placeholder + suffix`
 *   placeholder and select it.
 *
 * Toggling twice returns to the original (idempotent). Framed as one undo step
 * (undo stops before + after) and focused, matching the other edit helpers.
 *
 * @param editor      The live Monaco editor.
 * @param prefix      Markup before the selection/placeholder (e.g. `"*"`).
 * @param suffix      Markup after (e.g. `"*"`, or `"]"` for `#strike[…]).
 * @param placeholder Text to insert for a collapsed caret with no enclosing
 *   pair (default `"text"`).
 */
export function applyToggleWrap(
  editor: EditEditor,
  prefix: string,
  suffix: string,
  placeholder: string = DEFAULT_PLACEHOLDER,
): void {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;

  // Normalize to document order (start ≤ end). See applyWrapSelection for why.
  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const startCol = columnAtStart(sel, startLine);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endCol = columnAtEnd(sel, endLine);
  const collapsed = startLine === endLine && startCol === endCol;

  const wrappedSelectionRange = (fullSpanStartCol: number, inner: string) => ({
    startLineNumber: startLine,
    startColumn: fullSpanStartCol,
    endLineNumber: startLine,
    endColumn: fullSpanStartCol + inner.length,
  });

  if (!collapsed) {
    const range: Monaco.IRange = {
      startLineNumber: startLine,
      startColumn: startCol,
      endLineNumber: endLine,
      endColumn: endCol,
    };
    const selectedText = model.getValueInRange(range);

    if (
      selectedText.length >= prefix.length + suffix.length &&
      selectedText.startsWith(prefix) &&
      selectedText.endsWith(suffix)
    ) {
      // UNWRAP: drop the markers, keep the inner text, select it.
      const inner = selectedText.slice(
        prefix.length,
        selectedText.length - suffix.length,
      );
      const after = computeEndAfterInsert(startLine, startCol, inner);

      editor.pushUndoStop();
      editor.executeEdits("format-toggle-wrap", [{ range, text: inner }]);
      editor.setSelection({
        startLineNumber: startLine,
        startColumn: startCol,
        endLineNumber: after.line,
        endColumn: after.col,
      });
      editor.pushUndoStop();
      editor.focus();
      return;
    }
    // Not already wrapped → wrap (delegate to the existing helper, which frames
    // its own undo stops + focus).
    applyWrapSelection(editor, prefix, suffix, placeholder);
    return;
  }

  // Collapsed caret: single-line scan for an enclosing pair on this line.
  const line = model.getLineContent(startLine);
  const pair = findEnclosingWrap(line, startCol, prefix, suffix);
  if (!pair) {
    // No enclosing pair → insert a placeholder wrap (delegates undo/focus).
    applyWrapSelection(editor, prefix, suffix, placeholder);
    return;
  }

  // UNWRAP the pair span [pair.startCol, pair.endCol] → inner text.
  const inner = line.slice(
    pair.startCol - 1 + prefix.length,
    pair.endCol - 1 - suffix.length,
  );
  const range: Monaco.IRange = {
    startLineNumber: startLine,
    startColumn: pair.startCol,
    endLineNumber: startLine,
    endColumn: pair.endCol,
  };

  editor.pushUndoStop();
  editor.executeEdits("format-toggle-wrap", [{ range, text: inner }]);
  editor.setSelection(wrappedSelectionRange(pair.startCol, inner));
  editor.pushUndoStop();
  editor.focus();
}

/**
 * Query whether the current selection/caret sits inside a `prefix…suffix`
 * region on its line. Used by the format toolbar to set `aria-pressed` on the
 * bold/italic/code/strikethrough/quote buttons (state-aware toolbar T1).
 *
 * - **Collapsed caret:** true iff {@link findEnclosingWrap} finds an enclosing
 *   pair on the caret's line.
 * - **Non-empty selection:** true if the selected text itself is wrapped
 *   (starts with `prefix`, ends with `suffix`); otherwise, for a single-line
 *   selection, true if a pair on that line encloses the *whole* selection
 *   range. Multi-line selections that aren't themselves wrapped return false.
 *
 * Pure read: no edits, no undo stops, no focus.
 *
 * @param editor The live Monaco editor.
 * @param prefix Markup before the region (e.g. `"*"`).
 * @param suffix Markup after (e.g. `"*"`, or `"]"` for `#strike[…]).
 * @returns `true` if the selection/caret is inside a matching wrap.
 */
export function isInsideWrap(
  editor: EditEditor,
  prefix: string,
  suffix: string,
): boolean {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return false;

  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const startCol = columnAtStart(sel, startLine);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endCol = columnAtEnd(sel, endLine);
  const collapsed = startLine === endLine && startCol === endCol;

  if (collapsed) {
    const line = model.getLineContent(startLine);
    return findEnclosingWrap(line, startCol, prefix, suffix) !== null;
  }

  // Non-empty selection: first check whether the selection text itself is
  // wrapped (handles multi-line too — a multi-line selection that happens to
  // start with prefix and end with suffix counts as wrapped).
  const range: Monaco.IRange = {
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: endLine,
    endColumn: endCol,
  };
  const selectedText = model.getValueInRange(range);
  if (
    selectedText.length >= prefix.length + suffix.length &&
    selectedText.startsWith(prefix) &&
    selectedText.endsWith(suffix)
  ) {
    return true;
  }

  // Single-line selection: true if a pair on this line encloses the whole
  // selection range. (findEnclosingWrap already proves the start column is
  // inside the pair; we just also require the end column to be within the
  // pair's span.)
  if (startLine !== endLine) return false;
  const line = model.getLineContent(startLine);
  const pair = findEnclosingWrap(line, startCol, prefix, suffix);
  return pair !== null && pair.endCol >= endCol;
}

/**
 * Query whether the document-order first line of the selection starts with
 * `prefix`. Used by the format toolbar to set `aria-pressed` on the heading and
 * list buttons (state-aware toolbar T1).
 *
 * The check is a precise `startsWith` for the EXACT prefix, so it discriminates
 * heading levels correctly: a `== ` line returns TRUE for `"== "` but FALSE for
 * `"= "` (its second char is `=`, not ` `). Only the selection's START line is
 * consulted (the toolbar reflects the caret's anchor line).
 *
 * Pure read: no edits, no undo stops, no focus.
 *
 * @param editor The live Monaco editor.
 * @param prefix The exact line prefix to test (e.g. `"= "`, `"== "`, `"- "`).
 * @returns `true` if the selection's first line starts with `prefix`.
 */
export function isLinePrefixActive(editor: EditEditor, prefix: string): boolean {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return false;

  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  return model.getLineContent(startLine).startsWith(prefix);
}

/**
 * Toggle a line-prefix marker (e.g. `= ` H1, `== ` H2, `- ` bullet, `+ `
 * numbered) on every line touched by the selection (or just the caret's line
 * if collapsed).
 *
 * For each line in the range, in order:
 *  1. If it starts with a known Typst line prefix (`=+ `, `- `, `+ `), strip
 *     it (capture what was stripped).
 *  2. If `prefix` is *different* from the stripped prefix (or none was
 *     stripped), prepend `prefix`. If `prefix` *equals* the stripped prefix,
 *     the line ends up bare — the toggle is OFF.
 *
 * This gives the natural behavior: toggling `= ` twice returns to the original,
 * and switching H1 → H2 (`= ` → `== `) *replaces* rather than stacking.
 *
 * Cursor handling: for a single-line toggle the caret stays on its line with
 * its column adjusted by the prefix-length delta on that line; for a multi-line
 * selection the selection collapses to the start of the first affected line.
 * Framed with undo stops and focused.
 *
 * @param editor The live Monaco editor.
 * @param prefix The line prefix to toggle (e.g. `"= "`, `"- "`, `"+ "`).
 */
export function applyToggleLinePrefix(
  editor: EditEditor,
  prefix: string,
): void {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;

  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const collapsed = startLine === endLine;

  // For the collapsed case, capture the prefix delta on the caret's line BEFORE
  // the edit so we can shift the caret column to track the (now longer/shorter)
  // line. Multi-line edits collapse the selection, so the delta only matters
  // when a single line is in play.
  let caretDelta = 0;
  if (collapsed) {
    caretDelta = prefixDelta(model.getLineContent(startLine), prefix);
  }

  editor.pushUndoStop();

  // Precompute each line's new content and batch into a SINGLE executeEdits
  // call so the whole toggle is ONE undo unit (spec §5.1/§5.2: one toolbar
  // action = one undo step). Each executeEdits call is its own undoable unit,
  // so a per-line loop would make an N-line toggle cost N Ctrl+Z presses.
  // Prefix toggling never adds/removes newlines, so line numbers and column
  // math stay stable across the batch and the edits don't shift each other.
  const edits: { range: Monaco.IRange; text: string }[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const content = model.getLineContent(line);
    edits.push({
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: content.length + 1,
      },
      text: applyPrefixToLine(content, prefix),
    });
  }
  editor.executeEdits("format-toggle", edits);

  // Restore a sensible cursor. Single-line: keep the caret on its line, its
  // column shifted by the prefix delta on that line. Multi-line: collapse to
  // the start of the first line (per spec).
  if (collapsed) {
    const caretCol = clampColumn(model, startLine, sel.positionColumn + caretDelta);
    editor.setSelection({
      startLineNumber: startLine,
      startColumn: caretCol,
      endLineNumber: startLine,
      endColumn: caretCol,
    });
  } else {
    editor.setSelection({
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: startLine,
      endColumn: 1,
    });
  }

  editor.pushUndoStop();
  editor.focus();
}

/**
 * Toggle `prefix` on a single line's content and return the new content.
 * Pure helper shared by the edit loop and the delta computation.
 */
function applyPrefixToLine(content: string, prefix: string): string {
  const match = content.match(LINE_PREFIX_RE);
  const stripped = match ? match[1] : "";
  // If the line already has THIS prefix, toggle off (no re-add). Otherwise
  // strip any different known prefix and add the requested one.
  const newPrefix = prefix === stripped ? "" : prefix;
  return newPrefix + content.slice(stripped.length);
}

/**
 * The change in line length (newLength − oldLength) that toggling `prefix` on
 * `content` would produce. Used to shift the caret column on the edited line.
 */
function prefixDelta(content: string, prefix: string): number {
  const match = content.match(LINE_PREFIX_RE);
  const stripped = match ? match[1] : "";
  const newPrefix = prefix === stripped ? "" : prefix;
  return newPrefix.length - stripped.length;
}

/**
 * The column of the document-ORDER start of a selection (the smaller line's
 * column). For a single-line selection the start is `min(startCol, endCol)`;
 * for a multi-line selection the smaller line's column is always the start.
 *
 * Used together with {@link columnAtEnd} to normalize a (possibly reversed)
 * `ISelection` into a document-order range for both the edit and the post-edit
 * selection math — without this, a right-to-left selection would leave the
 * post-edit highlight in the wrong place.
 */
function columnAtStart(sel: Monaco.ISelection, startLine: number): number {
  // On the smaller line: pick that line's own column from whichever end of the
  // selection sits on it. For a single-line selection both ends are on this
  // line, so the start column is the smaller of the two.
  if (sel.selectionStartLineNumber === sel.positionLineNumber) {
    return Math.min(sel.selectionStartColumn, sel.positionColumn);
  }
  return sel.selectionStartLineNumber === startLine
    ? sel.selectionStartColumn
    : sel.positionColumn;
}

/**
 * The column of the document-ORDER end of a selection (the larger line's
 * column). Companion to {@link columnAtStart}.
 */
function columnAtEnd(sel: Monaco.ISelection, endLine: number): number {
  if (sel.selectionStartLineNumber === sel.positionLineNumber) {
    return Math.max(sel.selectionStartColumn, sel.positionColumn);
  }
  return sel.selectionStartLineNumber === endLine
    ? sel.selectionStartColumn
    : sel.positionColumn;
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Compute the (line, column) end coordinate of a piece of `text` inserted at
 * `(startLine, startCol)` — i.e. where the cursor lands after typing `text`.
 * Used to build the post-edit selection covering the inserted span.
 */
function computeEndAfterInsert(
  startLine: number,
  startCol: number,
  text: string,
): { line: number; col: number } {
  const newlines = countChar(text, "\n");
  if (newlines === 0) {
    return { line: startLine, col: startCol + text.length };
  }
  // After the last `\n`, the column is the length of the trailing segment + 1.
  const lastSegment = text.slice(text.lastIndexOf("\n") + 1);
  return { line: startLine + newlines, col: lastSegment.length + 1 };
}

function countChar(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

/** Clamp a column to the valid range [1, getLineMaxColumn] for the line. */
function clampColumn(model: EditModel, line: number, col: number): number {
  const max = model.getLineMaxColumn(line);
  return Math.max(1, Math.min(col, max));
}

/**
 * Find the nearest `prefix…suffix` pair on `line` that encloses column
 * `caretCol1Based`. Used by {@link applyToggleWrap} and {@link isInsideWrap} to
 * decide whether the caret sits inside a wrap region (bold `*…*`, italic
 * `_…_`, code `` `…` ``, strikethrough `#strike[…]`, quote `#quote[…]`).
 *
 * Returns the 1-based columns of the FULL pair span: `startCol` is the column
 * of the prefix's first char; `endCol` is the column AFTER the suffix's last
 * char (so the range `[startCol, endCol]` exactly covers `prefix…suffix` when
 * passed to `getValueInRange`, which slices `line.slice(startCol - 1, endCol - 1)`).
 * Returns `null` when no enclosing pair exists on the line.
 *
 * ## Column convention
 *
 * Column N means the caret sits AFTER the (N−1)th char (Monaco convention), so
 * the char immediately to the caret's LEFT is at 0-based index `N − 2`, and the
 * char to the RIGHT is at index `N − 1`. A pair `prefix…suffix` encloses the
 * caret when the prefix sits at-or-left of the caret's left char and the suffix
 * sits at-or-right of the caret's right char.
 *
 * ## Algorithm (greedy, single-line — NO marker balancing)
 *
 * 1. Scan leftward from the caret's left char for the rightmost `prefix`
 *    occurrence whose last char is at-or-left of the caret's left char. For
 *    symmetric markers (`prefix === suffix`) the prefix char itself must be
 *    ≤ the left index; for bracket-pair openers the whole opener must sit left
 *    of the caret.
 * 2. From that prefix's end, scan rightward for the nearest `suffix` whose
 *    first char is at-or-right of the caret's right char.
 * 3. If both exist, the pair encloses the caret → return it.
 *
 * For nested markers like `*_x_*` with the caret in `x`, this greedy approach
 * finds the INNERMOST layer for each marker type (`*` → the inner `*…*`,
 * `_` → the inner `_…_`), which is the desired toggle behavior (toggling bold
 * unwraps one layer at a time). Typst markup is simple enough that this greedy
 * scan is correct for the markers in play; this is intentionally NOT a parser.
 *
 * @param line            The single line of text to scan.
 * @param caretCol1Based  The 1-based caret column on that line.
 * @param prefix          The opener markup to find left of the caret.
 * @param suffix          The closer markup to find right of the caret.
 * @returns The 1-based `[startCol, endCol]` of the enclosing pair, or `null`.
 */
function findEnclosingWrap(
  line: string,
  caretCol1Based: number,
  prefix: string,
  suffix: string,
): { startCol: number; endCol: number } | null {
  // Caret's left char index (0-based) = caretCol1Based - 2; right char index
  // = caretCol1Based - 1. Clamp left at -1 (caret at column 1 → no left char).
  const leftIdx = caretCol1Based - 2;
  const rightIdx = caretCol1Based - 1;

  // Step 1: rightmost prefix occurrence whose last char sits at-or-left of the
  // caret's left char. lastIndexOf scans right-to-left, so its first hit (when
  // we cap the fromIndex at leftIdx - prefix.length + 1) is the nearest one.
  // For symmetric single-char markers, the prefix char can be the caret's left
  // char itself; for multi-char bracket openers (`#strike[`, `#quote[`) the
  // whole opener must sit at-or-left of the left char — the fromIndex cap below
  // handles both cases uniformly.
  const prefixFrom = leftIdx - prefix.length + 1;
  let prefixStart = line.lastIndexOf(prefix, Math.max(-1, prefixFrom));
  if (prefixStart === -1 || prefixStart + prefix.length - 1 > leftIdx) {
    return null;
  }
  // Edge: when prefix and suffix share text (e.g. symmetric `*`), the prefix
  // we found could itself be the suffix of a degenerate empty region; that's
  // fine — step 2 will still find a suffix to the right.

  // Step 2: nearest suffix occurrence whose first char sits at-or-right of the
  // caret's right char, AND at-or-after the prefix's end. Scan rightward.
  const suffixSearchFrom = Math.max(rightIdx, prefixStart + prefix.length);
  let suffixStart = line.indexOf(suffix, suffixSearchFrom);
  if (suffixStart === -1) {
    return null;
  }
  // Degenerate guard: for symmetric markers, the suffix we found could equal
  // the prefix position (empty content `**` with caret inside). Allow it — an
  // empty wrap is still a wrap.

  return {
    startCol: prefixStart + 1,
    endCol: suffixStart + suffix.length + 1,
  };
}
