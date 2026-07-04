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

  const collapsed =
    sel.selectionStartLineNumber === sel.positionLineNumber &&
    sel.selectionStartColumn === sel.positionColumn;

  const range: Monaco.IRange = {
    startLineNumber: sel.selectionStartLineNumber,
    startColumn: sel.selectionStartColumn,
    endLineNumber: sel.positionLineNumber,
    endColumn: sel.positionColumn,
  };

  let insertText: string;
  /** Selection to set after the edit: [startLine, startCol] → [endLine, endCol]. */
  let afterStart: { line: number; col: number };
  let afterEnd: { line: number; col: number };

  if (collapsed) {
    insertText = prefix + placeholder + suffix;
    // Placeholder sits at caret + prefix.length … caret + prefix.length + placeholder.length.
    afterStart = {
      line: range.startLineNumber,
      col: range.startColumn + prefix.length,
    };
    afterEnd = {
      line: afterStart.line,
      col: afterStart.col + placeholder.length,
    };
  } else {
    const selectedText = model.getValueInRange(range);
    insertText = prefix + selectedText + suffix;
    // Selection covers prefix + selected + suffix.
    afterStart = { line: range.startLineNumber, col: range.startColumn };
    afterEnd = computeEndAfterInsert(
      range.startLineNumber,
      range.startColumn,
      insertText,
    );
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

  const range: Monaco.IRange = {
    startLineNumber: sel.selectionStartLineNumber,
    startColumn: sel.selectionStartColumn,
    endLineNumber: sel.positionLineNumber,
    endColumn: sel.positionColumn,
  };

  const end = computeEndAfterInsert(range.startLineNumber, range.startColumn, text);

  editor.pushUndoStop();
  editor.executeEdits("format-replace", [{ range, text }]);
  editor.setSelection({
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: end.line,
    endColumn: end.col,
  });
  editor.pushUndoStop();
  editor.focus();
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
