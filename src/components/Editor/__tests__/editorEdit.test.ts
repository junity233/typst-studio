import { describe, it, expect } from "vitest";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import {
  applyWrapSelection,
  applyReplaceSelection,
  applyToggleLinePrefix,
  applyToggleWrap,
  isInsideWrap,
  isLinePrefixActive,
  getSelectionText,
} from "../editorEdit";
import type { EditEditor, EditModel } from "../editorEdit";

/**
 * Spec (Format Toolbar Task 1) — the pure edit seam behind `MonacoEditor.tsx`'s
 * `MonacoEditorApi.wrapSelection` / `replaceSelection` / `toggleLinePrefix`.
 *
 * The component cannot be integration-tested under vitest+jsdom (Monaco workers
 * + widget CSS), so the actual edit logic lives in plain helpers
 * (`editorEdit.ts`) that take a `Monaco.editor.IStandaloneCodeEditor` and is
 * tested here against an in-memory fake editor. The fake maintains a buffer
 * string + an ISelection-shaped cursor and implements exactly the surface the
 * helpers use (`getModel`, `getSelection`, `executeEdits`, `setSelection`,
 * `pushUndoStop`, `focus`). It is correct enough that the tests verify real
 * behavior, not just that a function was called.
 *
 * Helpers under test:
 * - `applyWrapSelection(editor, prefix, suffix, placeholder="text")`
 * - `applyReplaceSelection(editor, text)`
 * - `applyToggleLinePrefix(editor, prefix)`
 */

// ---------------------------------------------------------------------------
// Fake editor
// ---------------------------------------------------------------------------

/** A 1-based (line, column) coordinate, Monaco-style. */
interface Coord {
  lineNumber: number;
  column: number;
}

/**
 * Normalize a (possibly reversed) range to document order (start ≤ end by line,
 * then by column on the same line). Real Monaco's `Range` constructor and
 * `getValueInRange`/`executeEdits` accept reversed ranges and treat them as
 * their forward equivalent; the fake mirrors that so tests exercise the same
 * behavior the helpers see in production.
 */
function normalizeRange(range: Monaco.IRange): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
} {
  const { startLineNumber, startColumn, endLineNumber, endColumn } = range;
  if (
    startLineNumber < endLineNumber ||
    (startLineNumber === endLineNumber && startColumn <= endColumn)
  ) {
    return { startLineNumber, startColumn, endLineNumber, endColumn };
  }
  // Reversed — swap. For a same-line reversed range, the start column becomes
  // min(start,end); for a cross-line reversed range, the start line/column is
  // whichever end sits on the smaller line.
  if (startLineNumber === endLineNumber) {
    return {
      startLineNumber,
      startColumn: endColumn,
      endLineNumber,
      endColumn: startColumn,
    };
  }
  return {
    startLineNumber: endLineNumber,
    startColumn: endColumn,
    endLineNumber: startLineNumber,
    endColumn: startColumn,
  };
}

/**
 * In-memory editor that mimics the slice of `IStandaloneCodeEditor` the
 * `editorEdit` helpers use. Internally it keeps a buffer string (lines joined
 * by `\n`) and an `ISelection`-shaped cursor. Each helper call mutates both.
 *
 * Columns are 1-based: column 1 is before the first char on a line, column N
 * is after the (N-1)th char — matching Monaco's convention.
 */
class FakeEditor implements EditEditor {
  /** Full document text, `\n`-separated. */
  private buffer: string;
  /** The current selection (collapsed = caret). */
  private selection: Monaco.ISelection;

  /** Counts `pushUndoStop()` calls so tests can assert undo-stop framing. */
  undoStopCount = 0;
  /** Counts `focus()` calls so tests can assert the editor was focused. */
  focusCount = 0;
  /**
   * Counts `executeEdits` CALLS (not edits). Batching edits into one call is
   * what guarantees a single undo step on real Monaco (each executeEdits is its
   * own undo unit), so tests assert this stays at 1 for a multi-line toggle.
   */
  executeEditsCallCount = 0;
  /** Last source string passed to `executeEdits` (for debugging assertions). */
  lastEditSource: string | null | undefined = null;

  constructor(buffer: string, selection: Monaco.ISelection) {
    this.buffer = buffer;
    this.selection = { ...selection };
  }

  // -- model surface --------------------------------------------------------

  getModel(): EditModel {
    return new FakeModel(this);
  }

  // -- selection / position surface ----------------------------------------

  getSelection(): Monaco.ISelection {
    return { ...this.selection };
  }

  setSelection(sel: Monaco.IRange): void {
    // Monaco's setSelection accepts an IRange; we normalize to a forward
    // selection (start < end). Helpers always pass normalized ranges.
    this.selection = {
      selectionStartLineNumber: sel.startLineNumber,
      selectionStartColumn: sel.startColumn,
      positionLineNumber: sel.endLineNumber,
      positionColumn: sel.endColumn,
    };
  }

  focus(): void {
    this.focusCount++;
  }

  pushUndoStop(): boolean {
    this.undoStopCount++;
    return true;
  }

  // -- edit surface --------------------------------------------------------

  /**
   * Apply edits, matching `IStandaloneCodeEditor.executeEdits`. Each edit
   * replaces its `range` with `text`. Edits are applied in order; we apply them
   * back-to-front by buffer offset so earlier edits don't shift later ranges'
   * offsets. The only multi-edit caller is `applyToggleLinePrefix`, whose edits
   * sit on distinct lines (prefix toggling never adds/removes newlines), so the
   * ranges don't overlap regardless of order — back-to-front keeps it robust.
   */
  executeEdits(
    source: string | null | undefined,
    edits: Monaco.editor.IIdentifiedSingleEditOperation[],
  ): boolean {
    this.lastEditSource = source;
    this.executeEditsCallCount++;
    // Apply back-to-front by buffer offset so an earlier edit can't shift a
    // later edit's range. (Real Monaco applies the full batch atomically
    // against the pre-edit document; this emulates that ordering.)
    const withOffsets = edits.map((edit) => {
      // Normalize each edit's range to document order before computing offsets
      // — real Monaco applies edits against forward ranges, and a reversed
      // range would compute startOffset > endOffset (yielding an empty slice).
      const n = normalizeRange(edit.range);
      return {
        startOffset: this.toOffset({
          lineNumber: n.startLineNumber,
          column: n.startColumn,
        }),
        endOffset: this.toOffset({
          lineNumber: n.endLineNumber,
          column: n.endColumn,
        }),
        text: edit.text ?? "",
      };
    });
    withOffsets.sort((a, b) => b.startOffset - a.startOffset);
    for (const edit of withOffsets) {
      this.buffer =
        this.buffer.slice(0, edit.startOffset) +
        edit.text +
        this.buffer.slice(edit.endOffset);
    }
    return true;
  }

  // -- internals -----------------------------------------------------------

  private lines(): string[] {
    return this.buffer.split("\n");
  }

  /** Convert a (line, column) into a 0-based buffer offset. */
  private toOffset(c: Coord): number {
    const lines = this.lines();
    let offset = 0;
    for (let i = 0; i < c.lineNumber - 1; i++) {
      offset += lines[i].length + 1; // +1 for the `\n`
    }
    offset += c.column - 1;
    return offset;
  }
}

/**
 * Minimal `EditModel` fake backed by the parent `FakeEditor`'s buffer. It
 * implements exactly the model surface the helpers read; nothing else. The
 * `implements EditModel` clause is a compile-time contract check — if a helper
 * ever needs a new model method, this class won't satisfy the interface until
 * that method is added here, which keeps the fake honest.
 */
class FakeModel implements EditModel {
  constructor(private readonly owner: FakeEditor) {}

  getLineContent(lineNumber: number): string {
    return this.owner["lines"]()[lineNumber - 1] ?? "";
  }

  getValue(): string {
    return this.owner["buffer"];
  }

  getValueInRange(range: Monaco.IRange): string {
    // Normalize to document order — real Monaco's getValueInRange accepts
    // reversed ranges and reads them forward; the fake must match so tests
    // exercise the same behavior the helpers see in production.
    const n = normalizeRange(range);
    const lines = this.owner["lines"]();
    if (n.startLineNumber === n.endLineNumber) {
      const line = lines[n.startLineNumber - 1] ?? "";
      return line.slice(n.startColumn - 1, n.endColumn - 1);
    }
    const parts: string[] = [];
    for (let ln = n.startLineNumber; ln <= n.endLineNumber; ln++) {
      const line = lines[ln - 1] ?? "";
      if (ln === n.startLineNumber) {
        parts.push(line.slice(n.startColumn - 1));
      } else if (ln === n.endLineNumber) {
        parts.push(line.slice(0, n.endColumn - 1));
      } else {
        parts.push(line);
      }
    }
    return parts.join("\n");
  }

  getLineMaxColumn(lineNumber: number): number {
    return (this.owner["lines"]()[lineNumber - 1] ?? "").length + 1;
  }
}

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

/**
 * Build a FakeEditor with a single-line buffer and a collapsed caret at the
 * given column on line 1. (Most fixture cases are single-line.)
 */
function caret(buffer: string, column: number): FakeEditor {
  return new FakeEditor(buffer, {
    selectionStartLineNumber: 1,
    selectionStartColumn: column,
    positionLineNumber: 1,
    positionColumn: column,
  });
}

/**
 * Build a FakeEditor with a single-line buffer and a forward selection from
 * `startCol`..`endCol` on line 1. Columns are 1-based; a selection
 * `startCol..endCol` covers the chars at indices `(startCol-1)..(endCol-2)`,
 * matching Monaco's convention (column N is after the (N-1)th char).
 */
function sel(startCol: number, endCol: number, buffer: string): FakeEditor {
  return new FakeEditor(buffer, {
    selectionStartLineNumber: 1,
    selectionStartColumn: startCol,
    positionLineNumber: 1,
    positionColumn: endCol,
  });
}

/**
 * Build a FakeEditor with a single-line buffer and a REVERSED selection — the
 * anchor (selectionStart) is at `endCol` and the active position is at
 * `startCol`, emulating a right-to-left drag. The covered text is the same as
 * `sel(startCol, endCol)`, but the ISelection is reversed, which is what
 * `applyWrapSelection`/`applyReplaceSelection` must normalize before computing
 * the post-edit selection (regression coverage for the reversed-range bug).
 */
function selReversed(startCol: number, endCol: number, buffer: string): FakeEditor {
  return new FakeEditor(buffer, {
    selectionStartLineNumber: 1,
    selectionStartColumn: endCol,
    positionLineNumber: 1,
    positionColumn: startCol,
  });
}

// ===========================================================================
// applyWrapSelection
// ===========================================================================

describe("applyWrapSelection", () => {
  describe("collapsed caret (empty selection)", () => {
    it("inserts prefix+placeholder+suffix and selects the placeholder", () => {
      // The spec's canonical example: buffer `Hello world`, caret between
      // `Hello` and the space (column 6 — per Monaco's convention, column N is
      // after the (N-1)th char, so col 6 sits right after `o`). NOTE: the spec
      // text shows the result as `Hello *bold* world` (two spaces), but that's
      // impossible for any single-column insertion of `*bold*` — the original
      // has only one space. The column-convention-correct result is
      // `Hello*bold* world` (the prefix lands flush after `o`), which is what
      // a real Monaco editor produces for this exact input.
      const ed = caret("Hello world", 6);
      applyWrapSelection(ed, "*", "*", "bold");

      expect(ed.getModel().getValue()).toBe("Hello*bold* world");
      // placeholder `bold` sits at cols 7..11 → selection 7..11.
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 7,
        positionLineNumber: 1,
        positionColumn: 11,
      });
    });

    it("defaults the placeholder to 'text'", () => {
      const ed = caret("ab", 1);
      applyWrapSelection(ed, "_", "_");

      expect(ed.getModel().getValue()).toBe("_text_ab");
      expect(ed.getModel().getLineContent(1)).toBe("_text_ab");
      // placeholder `text` at cols 2..6.
      expect(ed.getSelection()).toMatchObject({
        selectionStartColumn: 2,
        positionColumn: 6,
      });
    });

    it("inserts at the very end of the buffer", () => {
      const ed = caret("foo", 4);
      applyWrapSelection(ed, "`", "`", "code");

      // buffer: f o ` c o d e `  →  `code` placeholder at cols 5..9
      // (placeholder sits AFTER the prefix backtick).
      expect(ed.getModel().getValue()).toBe("foo`code`");
      expect(ed.getSelection()).toMatchObject({
        selectionStartColumn: 5,
        positionColumn: 9,
      });
    });

    it("inserts at the very start (column 1)", () => {
      const ed = caret("foo", 1);
      applyWrapSelection(ed, "*", "*", "x");

      expect(ed.getModel().getValue()).toBe("*x*foo");
      expect(ed.getSelection()).toMatchObject({
        selectionStartColumn: 2,
        positionColumn: 3,
      });
    });

    it("pushes undo stops before AND after, and focuses the editor", () => {
      const ed = caret("Hello", 3);
      applyWrapSelection(ed, "*", "*", "p");

      expect(ed.undoStopCount).toBe(2);
      expect(ed.focusCount).toBe(1);
    });
  });

  describe("non-empty selection", () => {
    it("wraps the selected text and selects the whole wrapped span", () => {
      // buffer `Hello world`, selection = `world` (cols 7..12).
      const ed = sel(7, 12, "Hello world");
      applyWrapSelection(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("Hello *world*");
      // selection now covers `*world*` → cols 7..14.
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 7,
        positionLineNumber: 1,
        positionColumn: 14,
      });
    });

    it("ignores the placeholder argument when there is a real selection", () => {
      // sel 1..6 selects `Hello` (cols 1..6 = the first 5 chars).
      const ed = sel(1, 6, "Hello world");
      applyWrapSelection(ed, "_", "_", "ignored");

      expect(ed.getModel().getValue()).toBe("_Hello_ world");
    });

    it("wraps a selection at the start of the buffer", () => {
      const ed = sel(1, 4, "abcd"); // `abc`
      applyWrapSelection(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("*abc*d");
      expect(ed.getSelection()).toMatchObject({
        selectionStartColumn: 1,
        positionColumn: 6,
      });
    });

    it("pushes undo stops before AND after for a non-empty selection", () => {
      const ed = sel(1, 3, "abcdef");
      applyWrapSelection(ed, "*", "*");

      expect(ed.undoStopCount).toBe(2);
    });

    it("preserves the wrapped content exactly (whitespace, symbols)", () => {
      // sel 1..7 selects the first 6 chars: `  x = `+... actually `  x = 1` is
      // 7 chars; cols 1..8 select all of it.
      const ed = sel(1, 8, "  x = 1");
      applyWrapSelection(ed, "`", "`");

      expect(ed.getModel().getValue()).toBe("`  x = 1`");
    });
  });

  it("uses 'paste-convert'-style executeEdits with a stable source label", () => {
    // The fake records the source; helpers should pass a stable source label.
    // `applyWrapSelection` uses "format-wrap" so undo/redo stack labels are
    // predictable.
    const ed = sel(1, 3, "abcdef");
    applyWrapSelection(ed, "*", "*");
    expect(ed.lastEditSource).toBe("format-wrap");
  });

  describe("reversed selection (right-to-left drag)", () => {
    // Regression coverage: a reversed ISelection (anchor > active) must be
    // normalized before the post-edit selection is computed, otherwise the
    // highlight lands in the wrong place (covering text after the wrap point
    // rather than the wrapped span). Real Monaco normalizes the EDIT range
    // internally, so the inserted text was always correct — but the selection
    // math used the un-normalized anchor column.
    it("wraps the correct text and selects the wrapped span", () => {
      // selReversed(7, 12) covers `world` in `Hello world`, but anchor=12,
      // active=7 (right-to-left). Wrapping with * must yield `Hello *world*`
      // with the selection covering `*world*` (cols 7..13), NOT some span
      // starting at col 12.
      const ed = selReversed(7, 12, "Hello world");
      applyWrapSelection(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("Hello *world*");
      expect(ed.getSelection()).toEqual({
        // Forward selection over the wrapped span (col 7 .. col 14): the
        // selection is exclusive of the end char, so `*world*` (7 chars) ends
        // at col 7+7 = 14. Matches the forward-selection case.
        selectionStartLineNumber: 1,
        selectionStartColumn: 7,
        positionLineNumber: 1,
        positionColumn: 14,
      });
    });
  });
});

// ===========================================================================
// applyReplaceSelection
// ===========================================================================

describe("applyReplaceSelection", () => {
  it("inserts at a collapsed caret and selects the inserted text", () => {
    // caret at end of `foo`.
    const ed = caret("foo", 4);
    applyReplaceSelection(ed, "#line(length: 100%)\n");

    expect(ed.getModel().getValue()).toBe("foo#line(length: 100%)\n");
    // inserted text spans from col 4 (line 1) to col 1 (line 2) — but the
    // simplest correct assertion: the inserted run is selected. For a
    // multi-line insert the selection end is on line 2. We assert the start
    // anchor and that the inserted text is fully covered.
    const selNow = ed.getSelection();
    expect(selNow.selectionStartLineNumber).toBe(1);
    expect(selNow.selectionStartColumn).toBe(4);
    expect(selNow.positionLineNumber).toBe(2);
    // line 2 is empty after the trailing `\n`, so the caret/anchor sits at col 1.
    expect(selNow.positionColumn).toBe(1);
  });

  it("replaces a non-empty selection with the new text and selects it", () => {
    const ed = sel(1, 4, "abcdef"); // `abc`
    applyReplaceSelection(ed, "XYZ");

    expect(ed.getModel().getValue()).toBe("XYZdef");
    expect(ed.getSelection()).toEqual({
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 4,
    });
  });

  it("inserts at column 1", () => {
    const ed = caret("bar", 1);
    applyReplaceSelection(ed, "#image()\n");

    expect(ed.getModel().getValue()).toBe("#image()\nbar");
    expect(ed.getSelection()).toMatchObject({
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 2,
      positionColumn: 1,
    });
  });

  it("pushes undo stops before AND after, and focuses", () => {
    const ed = caret("foo", 4);
    applyReplaceSelection(ed, "X");

    expect(ed.undoStopCount).toBe(2);
    expect(ed.focusCount).toBe(1);
  });

  it("can replace a selection with an empty string (delete)", () => {
    const ed = sel(1, 4, "abcdef"); // delete `abc`
    applyReplaceSelection(ed, "");

    expect(ed.getModel().getValue()).toBe("def");
    // empty inserted text → collapsed selection at the deletion point.
    expect(ed.getSelection()).toEqual({
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    });
  });

  it("passes the 'format-replace' source label to executeEdits", () => {
    const ed = caret("foo", 4);
    applyReplaceSelection(ed, "X");
    expect(ed.lastEditSource).toBe("format-replace");
  });

  describe("reversed selection (right-to-left drag)", () => {
    // Regression coverage: same class of bug as applyWrapSelection's reversed
    // case — without normalization the post-edit selection covers the wrong
    // span (text after the insertion point rather than the inserted text).
    it("replaces the correct text and selects the inserted span", () => {
      // selReversed(7, 10) covers `wor` in `Hello world` (anchor=10, active=7).
      // Replacing with `XYZ` must yield `Hello XYZld` with the selection over
      // `XYZ` (cols 7..10), NOT a span starting at the old anchor col 10.
      const ed = selReversed(7, 10, "Hello world");
      applyReplaceSelection(ed, "XYZ");

      expect(ed.getModel().getValue()).toBe("Hello XYZld");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 7,
        positionLineNumber: 1,
        positionColumn: 10,
      });
    });
  });
});

// ===========================================================================
// getSelectionText
// ===========================================================================

describe("getSelectionText", () => {
  it("returns the selected text for a non-empty selection", () => {
    // sel 7..12 selects `world` in `Hello world` (cols 7..12 = chars at idx 6..10).
    const ed = sel(7, 12, "Hello world");
    expect(getSelectionText(ed)).toBe("world");
  });

  it("returns '' for a collapsed caret (empty selection)", () => {
    const ed = caret("Hello world", 6);
    expect(getSelectionText(ed)).toBe("");
  });

  it("returns the full buffer when the whole line is selected", () => {
    const ed = sel(1, 12, "Hello world");
    expect(getSelectionText(ed)).toBe("Hello world");
  });

  it("does not mutate the buffer or selection (pure read)", () => {
    const ed = sel(1, 5, "Hello world");
    const before = ed.getModel().getValue();
    const selBefore = ed.getSelection();
    getSelectionText(ed);
    expect(ed.getModel().getValue()).toBe(before);
    expect(ed.getSelection()).toEqual(selBefore);
    // A read must not frame edits or focus.
    expect(ed.undoStopCount).toBe(0);
    expect(ed.executeEditsCallCount).toBe(0);
    expect(ed.focusCount).toBe(0);
  });

  describe("reversed selection", () => {
    // Behavior pin: getSelectionText normalizes a reversed ISelection via
    // columnAtStart/columnAtEnd before reading. Real Monaco's getValueInRange
    // ALSO normalizes (its Range constructor swaps reversed ranges), so this is
    // belt-and-suspenders — but it pins the read path's correctness for an
    // upward drag (the Link button's wrap-vs-replace decision, spec §5.3), and
    // keeps this describe block symmetric with applyWrapSelection /
    // applyReplaceSelection's reversed-selection regression coverage above.
    it("same-line reversed returns the same text as forward", () => {
      // `world` in `Hello world`, selected right-to-left (anchor col 12, active 7).
      const ed = new FakeEditor("Hello world", {
        selectionStartLineNumber: 1,
        selectionStartColumn: 12,
        positionLineNumber: 1,
        positionColumn: 7,
      });
      expect(getSelectionText(ed)).toBe("world");
    });

    it("cross-line reversed (upward drag) returns the correct text", () => {
      // Buffer:
      //   line 1: "alpha"
      //   line 2: "beta"
      // Selection: anchor at line 2 col 4 (after "bet"), active at line 1
      // col 3 (after "al") — an UPWARD drag covering "pha\nbe".
      const ed = new FakeEditor("alpha\nbeta", {
        selectionStartLineNumber: 2,
        selectionStartColumn: 4,
        positionLineNumber: 1,
        positionColumn: 3,
      });
      // Document-order read: line 1 cols 3..end ("pha") + "\n" + line 2 cols 1..3 ("bet").
      expect(getSelectionText(ed)).toBe("pha\nbet");
    });
  });
});

// ===========================================================================
// applyToggleLinePrefix
// ===========================================================================

describe("applyToggleLinePrefix", () => {
  describe("single line, collapsed caret", () => {
    it("adds the prefix when the line has none", () => {
      const ed = caret("Hello", 6); // end of line 1
      applyToggleLinePrefix(ed, "= ");

      expect(ed.getModel().getLineContent(1)).toBe("= Hello");
    });

    it("toggles the SAME prefix off when it is already present", () => {
      const ed = caret("= Hello", 8);
      applyToggleLinePrefix(ed, "= ");

      expect(ed.getModel().getLineContent(1)).toBe("Hello");
    });

    it("REPLACES a different known prefix instead of stacking", () => {
      // From `= Hello`, toggle to `== `: strip `= ` then add `== ` → `== Hello`.
      const ed = caret("= Hello", 8);
      applyToggleLinePrefix(ed, "== ");

      expect(ed.getModel().getLineContent(1)).toBe("== Hello");
    });

    it("H1 → H3 replaces, not stacks (`=== ` from `= `)", () => {
      const ed = caret("= Hello", 8);
      applyToggleLinePrefix(ed, "=== ");

      expect(ed.getModel().getLineContent(1)).toBe("=== Hello");
    });

    it("strips a `- ` bullet before adding `= `", () => {
      const ed = caret("- Hello", 8);
      applyToggleLinePrefix(ed, "= ");

      expect(ed.getModel().getLineContent(1)).toBe("= Hello");
    });

    it("strips a `+ ` numbered marker before adding `- `", () => {
      const ed = caret("+ Hello", 8);
      applyToggleLinePrefix(ed, "- ");

      expect(ed.getModel().getLineContent(1)).toBe("- Hello");
    });

    it("toggles `- ` off when already a bullet", () => {
      const ed = caret("- one", 6);
      applyToggleLinePrefix(ed, "- ");

      expect(ed.getModel().getLineContent(1)).toBe("one");
    });

    it("does not treat an equals-sign run without a space as a heading", () => {
      // `=Hello` (no space) is NOT a Typst heading prefix; must not strip.
      const ed = caret("=Hello", 7);
      applyToggleLinePrefix(ed, "= ");

      expect(ed.getModel().getLineContent(1)).toBe("= =Hello");
    });

    it("leaves a blank line wrapped correctly (adds prefix to empty line)", () => {
      const ed = caret("", 1);
      applyToggleLinePrefix(ed, "- ");

      expect(ed.getModel().getLineContent(1)).toBe("- ");
    });

    it("adjusts the caret column when the prefix length changes on its line", () => {
      // Caret at end of `Hello` (col 6). After adding `= ` (2 chars), caret
      // should still be at the end of the (now longer) line → col 8.
      const ed = caret("Hello", 6);
      applyToggleLinePrefix(ed, "= ");

      const s = ed.getSelection();
      expect(s.positionLineNumber).toBe(1);
      expect(s.positionColumn).toBe(8);
    });

    it("adjusts caret down when toggling a prefix off", () => {
      // Caret at end of `= Hello` (col 8). After stripping `= ` → col 6.
      const ed = caret("= Hello", 8);
      applyToggleLinePrefix(ed, "= ");

      const s = ed.getSelection();
      expect(s.positionLineNumber).toBe(1);
      expect(s.positionColumn).toBe(6);
    });

    it("strips a `> ` block-quote prefix before adding the new prefix", () => {
      // `> quoted` starts with a known Typst block-quote prefix; toggling `- `
      // must strip the `> ` first then add `- ` → `- quoted`.
      const ed = caret("> quoted", 9);
      applyToggleLinePrefix(ed, "- ");

      expect(ed.getModel().getLineContent(1)).toBe("- quoted");
    });

    it("strips a `=== ` heading prefix before adding `- ` (deep → bullet)", () => {
      // From `=== deep`, toggle `- `: strip `=== ` then add `- ` → `- deep`.
      // Hardens the multi-char heading strip path.
      const ed = caret("=== deep", 9);
      applyToggleLinePrefix(ed, "- ");

      expect(ed.getModel().getLineContent(1)).toBe("- deep");
    });

    it("tracks the caret column on a mid-line toggle (caretDelta math)", () => {
      // Caret at col 3 of `Hello` (between `He` and `llo`). Toggling `= ` adds
      // 2 chars before the line, so the caret should track to col 5 of
      // `= Hello` (still between `He` and `llo`).
      const ed = caret("Hello", 3);
      applyToggleLinePrefix(ed, "= ");

      expect(ed.getModel().getLineContent(1)).toBe("= Hello");
      const s = ed.getSelection();
      expect(s.positionLineNumber).toBe(1);
      expect(s.positionColumn).toBe(5);
    });
  });

  describe("multi-line selection", () => {
    it("toggles the prefix on EVERY line in the selection range", () => {
      const ed = new FakeEditor("a\nb\nc", {
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 3,
        positionColumn: 2,
      });
      applyToggleLinePrefix(ed, "- ");

      const m = ed.getModel();
      expect(m.getLineContent(1)).toBe("- a");
      expect(m.getLineContent(2)).toBe("- b");
      expect(m.getLineContent(3)).toBe("- c");
    });

    it("removes the prefix from every line when all already have it", () => {
      const ed = new FakeEditor("- a\n- b", {
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 2,
        positionColumn: 4,
      });
      applyToggleLinePrefix(ed, "- ");

      const m = ed.getModel();
      expect(m.getLineContent(1)).toBe("a");
      expect(m.getLineContent(2)).toBe("b");
    });

    it("handles mixed prefixes within a multi-line selection", () => {
      const ed = new FakeEditor("= a\n- b", {
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 2,
        positionColumn: 4,
      });
      applyToggleLinePrefix(ed, "= ");

      const m = ed.getModel();
      // line 1 had `= ` → toggle off (same prefix).
      expect(m.getLineContent(1)).toBe("a");
      // line 2 had `- ` → strip then add `= `.
      expect(m.getLineContent(2)).toBe("= b");
    });

    it("collapses the selection to the start of the first affected line after edit", () => {
      const ed = new FakeEditor("a\nb\nc", {
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 3,
        positionColumn: 2,
      });
      applyToggleLinePrefix(ed, "- ");

      const s = ed.getSelection();
      // Acceptable per spec: collapse to start of first line.
      expect(s.selectionStartLineNumber).toBe(1);
      expect(s.positionLineNumber).toBe(1);
    });
  });

  it("pushes an undo stop before AND after, and focuses", () => {
    const ed = caret("Hello", 6);
    applyToggleLinePrefix(ed, "= ");

    expect(ed.undoStopCount).toBe(2);
    expect(ed.focusCount).toBe(1);
  });

  it("passes the 'format-toggle' source label to executeEdits", () => {
    const ed = caret("Hello", 6);
    applyToggleLinePrefix(ed, "= ");
    expect(ed.lastEditSource).toBe("format-toggle");
  });

  it("batches a single-line toggle into exactly ONE executeEdits call", () => {
    // One executeEdits call = one undo step on real Monaco.
    const ed = caret("Hello", 6);
    applyToggleLinePrefix(ed, "= ");
    expect(ed.executeEditsCallCount).toBe(1);
  });

  it("batches a multi-line toggle into exactly ONE executeEdits call", () => {
    // The whole toggle must be ONE undo unit (spec §5.1/§5.2), so a 5-line
    // toggle makes 1 executeEdits call, not 5 — otherwise it'd cost 5 Ctrl+Z
    // presses to undo. This guards against regressing back to a per-line loop.
    const ed = new FakeEditor("a\nb\nc\nd\ne", {
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 5,
      positionColumn: 2,
    });
    applyToggleLinePrefix(ed, "- ");

    expect(ed.executeEditsCallCount).toBe(1);
    const m = ed.getModel();
    expect(m.getLineContent(1)).toBe("- a");
    expect(m.getLineContent(5)).toBe("- e");
  });
});

// ===========================================================================
// applyToggleWrap
// ===========================================================================
//
// Spec (state-aware toolbar T1): an idempotent wrap toggle. If the
// selection/caret already sits inside a `prefix…suffix` region, UNWRAP it
// (replace the full span with the inner text); otherwise WRAP it (delegating to
// applyWrapSelection). Toggling twice returns to the original.

describe("applyToggleWrap", () => {
  describe("non-empty selection", () => {
    it("wraps unwrapped selected text (delegates to applyWrapSelection)", () => {
      // sel 1..4 selects `foo` in buffer `foobar`.
      const ed = sel(1, 4, "foobar");
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("*foo*bar");
      // selection covers the whole `*foo*` span → cols 1..6.
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 6,
      });
    });

    it("unwraps an already-wrapped selection (`*foo*` selected → `foo`)", () => {
      // buffer `*foo*`, selection covers all of it (cols 1..6 = `*foo*`).
      const ed = sel(1, 6, "*foo*");
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("foo");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 4,
      });
    });

    it("is idempotent: wrap then unwrap returns to the original", () => {
      const ed = caret("foo", 1);
      // Round-trip via explicit selections of the wrapped span.
      // Step 1: wrap `foo` (sel 1..4).
      ed.setSelection({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 4,
      });
      applyToggleWrap(ed, "*", "*");
      expect(ed.getModel().getValue()).toBe("*foo*");
      // Step 2: the selection now covers `*foo*` (cols 1..6); toggle again.
      applyToggleWrap(ed, "*", "*");
      expect(ed.getModel().getValue()).toBe("foo");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 4,
      });
    });

    it("does NOT unwrap a selection that only shares a prefix (`*foo` selected)", () => {
      // `*foo` starts with `*` but has no closing `*` → must WRAP, not strip.
      const ed = sel(1, 5, "*foo");
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("**foo*");
    });

    it("treats a selection shorter than prefix+suffix as not-wrapped", () => {
      // `*` alone (length 1) is shorter than prefix+suffix (2) → wrap it.
      const ed = sel(1, 2, "*");
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("***");
    });

    it("unwraps a strikethrough selection (`#strike[text]` → `text`)", () => {
      // buffer `#strike[text]`, selection covers all 14 chars.
      const ed = sel(1, 14, "#strike[text]");
      applyToggleWrap(ed, "#strike[", "]");

      expect(ed.getModel().getValue()).toBe("text");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 5,
      });
    });

    it("unwraps a quote selection (`#quote[text]` → `text`)", () => {
      const ed = sel(1, 13, "#quote[text]");
      applyToggleWrap(ed, "#quote[", "]");

      expect(ed.getModel().getValue()).toBe("text");
    });
  });

  describe("collapsed caret", () => {
    it("unwraps the enclosing pair (caret inside `*foo*`)", () => {
      // caret between `f` and `o` (col 3). Pair [1,6) → unwrap to `foo`.
      const ed = caret("*foo*", 3);
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("foo");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 4,
      });
    });

    it("inserts a placeholder when the caret is NOT inside any wrap", () => {
      const ed = caret("Hello world", 6);
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("Hello*text* world");
      // placeholder `text` at cols 7..11.
      expect(ed.getSelection()).toMatchObject({
        selectionStartColumn: 7,
        positionColumn: 11,
      });
    });

    it("inserts a custom placeholder when no pair encloses the caret", () => {
      const ed = caret("ab", 1);
      applyToggleWrap(ed, "_", "_", "italic");

      expect(ed.getModel().getValue()).toBe("_italic_ab");
    });

    it("unwraps a bracket-pair region (caret inside `#strike[foo]`)", () => {
      // buffer `#strike[foo]`, caret inside `foo` (col 10, between f and o).
      const ed = caret("#strike[foo]", 10);
      applyToggleWrap(ed, "#strike[", "]");

      expect(ed.getModel().getValue()).toBe("foo");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 4,
      });
    });

    it("unwraps a quote region (caret inside `#quote[bar]`)", () => {
      // caret inside `bar` (col 10).
      const ed = caret("#quote[bar]", 10);
      applyToggleWrap(ed, "#quote[", "]");

      expect(ed.getModel().getValue()).toBe("bar");
    });

    it("unwraps the INNERMOST layer of nested `*_x_*` for bold", () => {
      // caret inside `x` (col 4). Toggling bold unwraps the inner `*…*` → `_x_`.
      const ed = caret("*_x_*", 4);
      applyToggleWrap(ed, "*", "*");

      expect(ed.getModel().getValue()).toBe("_x_");
      expect(ed.getSelection()).toEqual({
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 4,
      });
    });

    it("unwraps the italic layer of nested `*_x_*` for italic", () => {
      // caret inside `x` (col 4). Toggling italic unwraps `_…_` → `*x*`.
      const ed = caret("*_x_*", 4);
      applyToggleWrap(ed, "_", "_");

      expect(ed.getModel().getValue()).toBe("*x*");
    });
  });

  describe("undo-stop framing + source label", () => {
    it("pushes undo stops before AND after on the unwrap path, and focuses", () => {
      const ed = sel(1, 6, "*foo*");
      applyToggleWrap(ed, "*", "*");

      expect(ed.undoStopCount).toBe(2);
      expect(ed.focusCount).toBe(1);
    });

    it("pushes undo stops on the caret-unwrap path too", () => {
      const ed = caret("*foo*", 3);
      applyToggleWrap(ed, "*", "*");

      expect(ed.undoStopCount).toBe(2);
      expect(ed.focusCount).toBe(1);
    });

    it("uses the 'format-toggle-wrap' source label on the unwrap path", () => {
      const ed = sel(1, 6, "*foo*");
      applyToggleWrap(ed, "*", "*");
      expect(ed.lastEditSource).toBe("format-toggle-wrap");
    });

    it("batches the caret-unwrap into exactly ONE executeEdits call", () => {
      const ed = caret("*foo*", 3);
      applyToggleWrap(ed, "*", "*");
      expect(ed.executeEditsCallCount).toBe(1);
    });
  });
});

// ===========================================================================
// isInsideWrap
// ===========================================================================
//
// Spec (state-aware toolbar T1): pure query used by the toolbar to set
// aria-pressed. True when the selection/caret sits inside a `prefix…suffix`
// region on its line. Never mutates the buffer/selection, never frames edits.

describe("isInsideWrap", () => {
  describe("collapsed caret", () => {
    it("returns true when the caret is inside `*foo*` (bold)", () => {
      const ed = caret("*foo*", 3);
      expect(isInsideWrap(ed, "*", "*")).toBe(true);
    });

    it("returns false when the caret is outside any wrap", () => {
      const ed = caret("Hello world", 6);
      expect(isInsideWrap(ed, "*", "*")).toBe(false);
    });

    it("returns true for strike, false for bold when inside `#strike[x]`", () => {
      const ed = caret("#strike[x]", 10);
      expect(isInsideWrap(ed, "#strike[", "]")).toBe(true);
      expect(isInsideWrap(ed, "*", "*")).toBe(false);
    });

    it("returns true for BOTH bold and italic when the caret is in nested `*_x_*`", () => {
      const ed = caret("*_x_*", 4);
      expect(isInsideWrap(ed, "*", "*")).toBe(true);
      expect(isInsideWrap(ed, "_", "_")).toBe(true);
    });
  });

  describe("non-empty selection", () => {
    it("returns true when the selection text itself is wrapped (`*foo*`)", () => {
      const ed = sel(1, 6, "*foo*");
      expect(isInsideWrap(ed, "*", "*")).toBe(true);
    });

    it("returns false when the selection text is unwrapped (`foo`)", () => {
      const ed = sel(1, 4, "foo");
      expect(isInsideWrap(ed, "*", "*")).toBe(false);
    });

    it("returns true when a single-line selection is fully enclosed by a pair", () => {
      // buffer `*foo*`, select only `foo` (cols 2..5). The pair [1,6) encloses it.
      const ed = sel(2, 5, "*foo*");
      expect(isInsideWrap(ed, "*", "*")).toBe(true);
    });

    it("returns false when a single-line selection extends past the pair", () => {
      // buffer `*foo* bar`, select `*foo*` + the space (cols 1..7). The pair
      // [1,6) does NOT enclose col 7 → false.
      const ed = sel(1, 7, "*foo* bar");
      expect(isInsideWrap(ed, "*", "*")).toBe(false);
    });

    it("returns true for a selection fully inside the pair (`foo` in `*foo* bar`)", () => {
      // select `foo` (cols 2..5) inside the pair [1,6) → enclosed.
      const ed = sel(2, 5, "*foo* bar");
      expect(isInsideWrap(ed, "*", "*")).toBe(true);
    });
  });

  describe("pure read (no mutation)", () => {
    it("does not mutate the buffer, selection, or frame edits/focus", () => {
      const ed = sel(1, 6, "*foo*");
      const beforeBuffer = ed.getModel().getValue();
      const beforeSel = ed.getSelection();
      const result = isInsideWrap(ed, "*", "*");

      expect(result).toBe(true);
      expect(ed.getModel().getValue()).toBe(beforeBuffer);
      expect(ed.getSelection()).toEqual(beforeSel);
      expect(ed.undoStopCount).toBe(0);
      expect(ed.executeEditsCallCount).toBe(0);
      expect(ed.focusCount).toBe(0);
    });
  });
});

// ===========================================================================
// isLinePrefixActive
// ===========================================================================
//
// Spec (state-aware toolbar T1): pure query for the heading/list buttons.
// True iff the selection's document-order first line starts with `prefix`.
// The precise startsWith check discriminates heading levels: `== ` is NOT
// active for `"= "` because its second char is `=`, not ` `.

describe("isLinePrefixActive", () => {
  it("returns true when the line starts with the prefix (`= Hello`, `= `)", () => {
    const ed = caret("= Hello", 1);
    expect(isLinePrefixActive(ed, "= ")).toBe(true);
  });

  it("discriminates heading levels: `== Hello` is NOT `= `, but IS `== `", () => {
    const ed = caret("== Hello", 1);
    expect(isLinePrefixActive(ed, "= ")).toBe(false);
    expect(isLinePrefixActive(ed, "== ")).toBe(true);
  });

  it("discriminates H3: `=== Deep` is NOT `== `, but IS `=== `", () => {
    const ed = caret("=== Deep", 1);
    expect(isLinePrefixActive(ed, "== ")).toBe(false);
    expect(isLinePrefixActive(ed, "=== ")).toBe(true);
  });

  it("returns true for a bullet prefix, false for a different prefix", () => {
    const ed = caret("- item", 1);
    expect(isLinePrefixActive(ed, "- ")).toBe(true);
    expect(isLinePrefixActive(ed, "+ ")).toBe(false);
  });

  it("returns false for plain text under any prefix", () => {
    const ed = caret("plain text", 1);
    expect(isLinePrefixActive(ed, "= ")).toBe(false);
    expect(isLinePrefixActive(ed, "- ")).toBe(false);
  });

  it("only inspects the START line of a multi-line selection", () => {
    // line 1 has `- `, line 2 is plain.
    const ed = new FakeEditor("- item\nplain", {
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 2,
      positionColumn: 6,
    });
    expect(isLinePrefixActive(ed, "- ")).toBe(true);
    expect(isLinePrefixActive(ed, "= ")).toBe(false);
  });

  it("inspects the start line even for a reversed (upward) selection", () => {
    // anchor on line 2 (plain), active on line 1 (`= `) — start line is line 1.
    const ed = new FakeEditor("= h1\nplain", {
      selectionStartLineNumber: 2,
      selectionStartColumn: 6,
      positionLineNumber: 1,
      positionColumn: 1,
    });
    expect(isLinePrefixActive(ed, "= ")).toBe(true);
  });

  it("does not treat an equals run without a space as a heading", () => {
    // `=Hello` (no space) is NOT a Typst heading prefix.
    const ed = caret("=Hello", 1);
    expect(isLinePrefixActive(ed, "= ")).toBe(false);
  });

  it("is a pure read: no buffer/selection mutation, no edits/focus", () => {
    const ed = caret("= Hello", 1);
    const beforeBuffer = ed.getModel().getValue();
    const beforeSel = ed.getSelection();
    const result = isLinePrefixActive(ed, "= ");

    expect(result).toBe(true);
    expect(ed.getModel().getValue()).toBe(beforeBuffer);
    expect(ed.getSelection()).toEqual(beforeSel);
    expect(ed.undoStopCount).toBe(0);
    expect(ed.executeEditsCallCount).toBe(0);
    expect(ed.focusCount).toBe(0);
  });
});
