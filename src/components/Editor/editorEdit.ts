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
 * Replace the unique first occurrence of `oldString` with `newString` in the
 * editor buffer. Used by the AI assistant's `edit` tool.
 *
 * - Returns `false` (no-op) when `oldString` is absent from the buffer, or when
 *   it occurs more than once (the caller — the agent — must supply more context
 *   to disambiguate). This mirrors the behavior the agent is told about in the
 *   system prompt and keeps the change deterministic.
 * - The change is a single undo step: `pushUndoStop` before and after the
 *   `executeEdits`, matching the {@link applyReplaceSelection} framing.
 * - Leaves the selection at the end of the inserted text.
 *
 * Offset → (line, column) translation walks model lines; offsets are 0-based
 * character offsets into `model.getValue()` (Monaco uses 1-based line/column).
 */
export function applyStrReplace(
  editor: EditEditor,
  oldString: string,
  newString: string,
): boolean {
  const model = editor.getModel();
  if (!model) return false;

  const full = model.getValue();
  const first = full.indexOf(oldString);
  if (first === -1) return false;
  const second = full.indexOf(oldString, first + 1);
  if (second !== -1) return false; // ambiguous — refuse

  const range = offsetsToRange(model, first, first + oldString.length);

  editor.pushUndoStop();
  editor.executeEdits("ai-str-replace", [{ range, text: newString }]);
  const end = computeEndAfterInsert(range.startLineNumber, range.startColumn, newString);
  editor.setSelection({
    startLineNumber: end.line,
    startColumn: end.col,
    endLineNumber: end.line,
    endColumn: end.col,
  });
  editor.pushUndoStop();
  editor.focus();
  return true;
}

/**
 * Translate 0-based character offsets into a Monaco `{startLineNumber,
 * startColumn, endLineNumber, endColumn}` range by walking model lines. Both
 * offsets must point at valid positions in `model.getValue()`.
 */
function offsetsToRange(
  model: EditModel,
  startOffset: number,
  endOffset: number,
): Monaco.IRange {
  const value = model.getValue();
  let line = 1;
  let lineStart = 0; // 0-based offset of the current line's first char
  let start: { line: number; col: number } | null = null;
  let end: { line: number; col: number } | null = null;

  // Walk line boundaries until both offsets are pinned. We re-derive line
  // starts from `getValue()` (rather than `getLineCount`) so the fake editor
  // in tests — which may not implement `getLineCount` — still works.
  const lines = value.split("\n");
  for (let l = 0; l < lines.length; l++) {
    const lineEnd = lineStart + lines[l].length; // 0-based, exclusive of newline
    if (!start && startOffset <= lineEnd) {
      start = { line: line, col: startOffset - lineStart + 1 };
    }
    if (!end && endOffset <= lineEnd + 1) {
      end = { line: line, col: endOffset - lineStart + 1 };
    }
    if (start && end) break;
    line++;
    lineStart = lineEnd + 1; // +1 for the `\n`
  }
  const s = start ?? { line: 1, col: 1 };
  const e = end ?? s;
  return {
    startLineNumber: s.line,
    startColumn: s.col,
    endLineNumber: e.line,
    endColumn: e.col,
  };
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
 * Return the 1-indexed source lines actually covered by the current selection,
 * in document order. A collapsed caret returns `[]`.
 *
 * Monaco selections are half-open, so a cross-line selection that ends at
 * column 1 of the next line does NOT count that final line as selected.
 */
export function getSelectedLines(
  editor: Pick<EditEditor, "getSelection">,
): number[] {
  const sel = editor.getSelection();
  if (!sel) return [];

  const startLine = Math.min(sel.selectionStartLineNumber, sel.positionLineNumber);
  const startCol = columnAtStart(sel, startLine);
  const endLine = Math.max(sel.selectionStartLineNumber, sel.positionLineNumber);
  const endCol = columnAtEnd(sel, endLine);

  if (startLine === endLine && startCol === endCol) return [];

  const inclusiveEndLine =
    startLine !== endLine && endCol === 1 ? endLine - 1 : endLine;
  const lines: number[] = [];
  for (let line = startLine; line <= inclusiveEndLine; line++) {
    lines.push(line);
  }
  return lines;
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
export function computeEndAfterInsert(
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
 * Find the innermost `prefix…suffix` pair on `line` that encloses column
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
 * caret when the opener sits at-or-left of the caret's left char AND the closer
 * sits at-or-right of the caret's right char: `openerStart <= leftIdx` and
 * `closerStart >= rightIdx`.
 *
 * ## Algorithm (BALANCED, single-line — opener/closer are matched pairs)
 *
 * The earlier greedy "nearest prefix left + nearest suffix right" scan produced
 * two correctness bugs because it never verified the candidate markers were a
 * matched opener→content→closer pair:
 *  - Adjacent same-type wraps (`*a* *b*`) with the caret in the gap matched the
 *    CLOSING `*` of `*a*` as "prefix" and the OPENING `*` of `*b*` as "suffix",
 *    corrupting the buffer on toggle (`*a b*`).
 *  - Bracket-suffix sharing (`#strike[x] #quote[y]`) matched a `#strike[` opener
 *    with a `]` belonging to `#quote[`, mis-reporting `isInsideWrap`.
 *
 * Both are fixed by ensuring the opener and closer are a balanced pair:
 *
 * **Symmetric markers (`prefix === suffix`, e.g. `*`, `_`, `` ` ``):** collect
 * every marker occurrence in order; pair them by alternation (the 1st, 3rd, …
 * are openers; the 2nd, 4th, … are their closers). The innermost pair whose
 * opener is at-or-left of the caret AND whose closer is at-or-right of the
 * caret encloses it. Two adjacent wraps `*a* *b*` therefore pair as
 * `(*a*)(*b*)`, never `(*a* *b*)`, so a caret in the gap has no enclosing pair.
 *
 * **Bracket-pair markers (`prefix !== suffix`, e.g. `#strike[` + `]`):** find
 * candidate openers (the specific `prefix` string) to the left of the caret,
 * rightmost-first; for each, depth-count-scan right for its MATCHING closer
 * (the `]` that brings the open-bracket depth back to where it was right after
 * this opener, accounting for intervening `#xxx[` openers and their `]`
 * closers). Return the first (innermost) candidate whose pair spans the caret.
 * `#strike[x] #quote[y]` thus pairs `#strike[` with the `]` after `x` (not the
 * one after `y`), so a caret in `y` is NOT inside `#strike[…]`.
 *
 * This is intentionally NOT a full Typst parser — it balances only the marker
 * family in play on a single line, which is enough for the toolbar's
 * wrap-awareness.
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

  // A pair encloses the caret when the opener sits at-or-left of the left char
  // AND the closer sits at-or-right of the right char. (Closer START index ≥
  // rightIdx means the whole suffix is at-or-right of the caret.)
  const encloses = (openerStart: number, closerStart: number): boolean =>
    openerStart <= leftIdx && closerStart >= rightIdx;

  if (prefix === suffix) {
    // --- Symmetric markers: alternation pairing ----------------------------
    // Collect every occurrence index of the marker in order. Even-indexed
    // occurrences are openers, the following odd-indexed occurrence is its
    // closer (e.g. `*a* *b*` → [0,2,4,6] → pairs (0,2),(4,6)). This guarantees
    // the opener/closer are a matched pair, so two adjacent wraps never get
    // spliced together. Walk left-to-right and keep the LAST pair that
    // encloses the caret = the innermost.
    const occ: number[] = [];
    for (let i = line.indexOf(prefix); i !== -1; i = line.indexOf(prefix, i + 1)) {
      occ.push(i);
    }
    let result: { startCol: number; endCol: number } | null = null;
    for (let k = 0; k + 1 < occ.length; k += 2) {
      const opener = occ[k];
      const closer = occ[k + 1];
      if (encloses(opener, closer)) {
        // Later (deeper-right) wins = innermost. Because occurrences are in
        // order and pairs don't overlap under alternation, the last enclosing
        // pair is the innermost one around the caret.
        result = { startCol: opener + 1, endCol: closer + suffix.length + 1 };
      }
    }
    return result;
  }

  // --- Bracket-pair markers: depth-counting closer match -------------------
  // Find candidate openers (the exact `prefix` string) sitting at-or-left of
  // the caret, scanning right-to-left so the first enclosing match is the
  // innermost. For each candidate, find its MATCHING closer by depth-counting
  // open brackets (`#xxx[`) and close brackets (`]`) starting right after the
  // opener — this skips `]`s that belong to intervening openers, so
  // `#strike[x] #quote[y]` pairs `#strike[` with the `]` after `x`, not `y`.
  const openerEndContent = (openerStart: number) => openerStart + prefix.length;
  // Scan candidate openers right-to-left. NOTE: `lastIndexOf(prefix, -1)`
  // returns 0 in JS (negative fromIndex normalizes to 0), so when the current
  // candidate is at index 0 we must stop after processing it — decrementing to
  // -1 and re-calling would re-find index 0 forever (infinite loop).
  let openerStart = line.lastIndexOf(prefix, Math.max(-1, leftIdx - prefix.length + 1));
  while (openerStart !== -1) {
    if (openerStart + prefix.length - 1 <= leftIdx) {
      const closerStart = findMatchingCloser(line, openerEndContent(openerStart), suffix);
      if (closerStart !== -1 && encloses(openerStart, closerStart)) {
        return { startCol: openerStart + 1, endCol: closerStart + suffix.length + 1 };
      }
    }
    if (openerStart === 0) break; // avoid lastIndexOf(prefix,-1) re-finding 0
    openerStart = line.lastIndexOf(prefix, openerStart - 1);
  }
  return null;
}

/**
 * Scan right from `fromIdx` on `line` for the `suffix` closer that matches the
 * opener already consumed before `fromIdx`, depth-counting any intervening
 * bracket openers of the same family. Used by {@link findEnclosingWrap} for the
 * bracket-pair case (`prefix !== suffix`, e.g. `#strike[` + `]`).
 *
 * "Same family" = any `#xxx[` opener (a `#`, an identifier run, then `[`)
 * shares the `]` closer namespace with our suffix `]`. We start at depth 1
 * (one opener already open) and look for the `]` that brings depth back to 0,
 * decrementing on each `]` and incrementing on each `#xxx[` encountered. This
 * is what disambiguates `#strike[x] #quote[y]` (the `]` after `x` closes
 * `#strike[`) and handles nesting like `#strike[#quote[x]]`.
 *
 * @param line     The line being scanned.
 * @param fromIdx  The 0-based index just AFTER the opener's last char.
 * @param suffix   The closer markup (e.g. `"]"`).
 * @returns The 0-based start index of the matching closer, or `-1` if none.
 */
function findMatchingCloser(line: string, fromIdx: number, suffix: string): number {
  // Matches same-family bracket openers `#name[` to depth-count. The identifier
  // is a run of letters/digits; this covers Typst's `#strike[`, `#quote[`,
  // `#emph[`, `#strong[`, etc.
  const OPENER_RE = /\#[A-Za-z0-9_]+\[/g;
  let depth = 1; // one opener (our prefix) already open
  let i = fromIdx;
  while (i < line.length) {
    // Try a same-family opener at position i.
    if (line[i] === "#") {
      OPENER_RE.lastIndex = i;
      const m = OPENER_RE.exec(line);
      if (m && m.index === i) {
        depth++;
        i = OPENER_RE.lastIndex; // just past the `[`
        continue;
      }
    }
    // Try the closer at position i.
    if (suffix.length > 0 && line.startsWith(suffix, i)) {
      depth--;
      if (depth === 0) return i;
      i += suffix.length;
      continue;
    }
    i++;
  }
  return -1;
}
