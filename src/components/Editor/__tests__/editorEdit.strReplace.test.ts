import { describe, it, expect } from "vitest";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import { applyStrReplace } from "../editorEdit";
import type { EditEditor, EditModel } from "../editorEdit";

/**
 * Spec (AI Assistant Task 4) — `applyStrReplace` is the editor seam behind the
 * agent's `edit` tool. Like the format-toolbar helpers, it's tested here
 * against an in-memory fake editor rather than real Monaco (which can't run
 * under jsdom). The fake mirrors the slice of `IStandaloneCodeEditor` the
 * helper uses: `getModel` + `executeEdits` + `setSelection` + `pushUndoStop`
 * + `focus`.
 */

/** Minimal in-memory model backing the fake editor. */
class FakeModel implements EditModel {
  constructor(private buffer: string) {}
  getLineContent(lineNumber: number): string {
    return this.buffer.split("\n")[lineNumber - 1] ?? "";
  }
  getLineMaxColumn(lineNumber: number): number {
    return (this.buffer.split("\n")[lineNumber - 1] ?? "").length + 1;
  }
  getValueInRange(range: Monaco.IRange): string {
    const lines = this.buffer.split("\n");
    if (range.startLineNumber === range.endLineNumber) {
      const line = lines[range.startLineNumber - 1] ?? "";
      return line.slice(range.startColumn - 1, range.endColumn - 1);
    }
    // Multi-line: not needed by applyStrReplace tests, but implement for safety.
    const parts = [lines[range.startLineNumber - 1].slice(range.startColumn - 1)];
    for (let l = range.startLineNumber + 1; l < range.endLineNumber; l++) {
      parts.push(lines[l - 1]);
    }
    parts.push(lines[range.endLineNumber - 1].slice(0, range.endColumn - 1));
    return parts.join("\n");
  }
  getValue(): string {
    return this.buffer;
  }
}

/** Minimal in-memory editor implementing the `EditEditor` surface. */
class FakeEditor implements EditEditor {
  private buffer: string;
  private selection: Monaco.ISelection | null = null;
  executeEditsCallCount = 0;
  undoStopCount = 0;

  constructor(buffer: string) {
    this.buffer = buffer;
  }
  getModel(): EditModel | null {
    return new FakeModel(this.buffer);
  }
  getSelection(): Monaco.ISelection | null {
    return this.selection;
  }
  setSelection(sel: Monaco.IRange): void {
    this.selection = {
      selectionStartLineNumber: sel.startLineNumber,
      selectionStartColumn: sel.startColumn,
      positionLineNumber: sel.endLineNumber,
      positionColumn: sel.endColumn,
      selectionId: 0,
    } as Monaco.ISelection;
  }
  executeEdits(
    _source: string | null | undefined,
    edits: Monaco.editor.IIdentifiedSingleEditOperation[],
  ): boolean {
    this.executeEditsCallCount++;
    // Apply the first edit. Reconstruct the buffer by slicing on lines.
    for (const op of edits) {
      const { range, text } = op;
      const lines = this.buffer.split("\n");
      const before = lines.slice(0, range.startLineNumber - 1);
      const startLine = lines[range.startLineNumber - 1] ?? "";
      const endLine = lines[range.endLineNumber - 1] ?? "";
      const prefix = startLine.slice(0, range.startColumn - 1);
      const suffix = endLine.slice(range.endColumn - 1);
      const middle = text.split("\n");
      const rebuilt = [prefix + middle[0]];
      for (let i = 1; i < middle.length; i++) rebuilt.push(middle[i]);
      rebuilt[rebuilt.length - 1] = rebuilt[rebuilt.length - 1] + suffix;
      const tail = lines.slice(range.endLineNumber);
      this.buffer = [...before, ...rebuilt, ...tail].join("\n");
    }
    return true;
  }
  pushUndoStop(): boolean {
    this.undoStopCount++;
    return true;
  }
  focus(): void {}
  /** Test helper: read the resulting buffer. */
  value(): string {
    return this.buffer;
  }
}

describe("applyStrReplace", () => {
  it("replaces a unique snippet on a single line", () => {
    const ed = new FakeEditor("= 第二章\n正文");
    expect(applyStrReplace(ed, "= 第二章", "= 第二章 <large>")).toBe(true);
    expect(ed.value()).toBe("= 第二章 <large>\n正文");
    expect(ed.executeEditsCallCount).toBe(1);
    expect(ed.undoStopCount).toBe(2); // one before, one after = single undo step
  });

  it("replaces a multi-line snippet", () => {
    const ed = new FakeEditor("a\nb\nc\nd");
    expect(applyStrReplace(ed, "b\nc", "X\nY")).toBe(true);
    expect(ed.value()).toBe("a\nX\nY\nd");
  });

  it("no-ops (returns false) when old_string is not found", () => {
    const ed = new FakeEditor("hello");
    expect(applyStrReplace(ed, "missing", "x")).toBe(false);
    expect(ed.value()).toBe("hello");
    expect(ed.executeEditsCallCount).toBe(0);
    expect(ed.undoStopCount).toBe(0);
  });

  it("no-ops when old_string matches more than once", () => {
    const ed = new FakeEditor("foo bar foo");
    expect(applyStrReplace(ed, "foo", "x")).toBe(false);
    expect(ed.value()).toBe("foo bar foo");
    expect(ed.executeEditsCallCount).toBe(0);
  });

  it("no-ops when there is no model (editor torn down)", () => {
    const ed = new FakeEditor("hello");
    (ed.getModel as unknown) = () => null;
    expect(() => applyStrReplace(ed, "hello", "x")).not.toThrow();
    expect(applyStrReplace(ed, "hello", "x")).toBe(false);
  });

  it("places the caret at the end of the inserted text", () => {
    const ed = new FakeEditor("= Title\nbody");
    applyStrReplace(ed, "Title", "Title <large>");
    const sel = ed.getSelection()!;
    // Inserted "Title <large>" ends at column 16 on line 1.
    expect(sel.positionLineNumber).toBe(1);
    expect(sel.positionColumn).toBe(16);
  });

  it("handles a multi-line insertion correctly", () => {
    const ed = new FakeEditor("line1\nline2");
    applyStrReplace(ed, "line1", "line1\n  # comment");
    // Caret should be on line 2, after "  # comment".
    const sel = ed.getSelection()!;
    expect(sel.positionLineNumber).toBe(2);
    expect(sel.positionColumn).toBe("  # comment".length + 1);
  });
});
