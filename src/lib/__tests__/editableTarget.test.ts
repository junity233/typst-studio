import { describe, it, expect } from "vitest";
import { isEditableTarget } from "../editableTarget";

/**
 * Unit tests for `isEditableTarget` — the single implementation point of the
 * user-perceivable rule "app-global shortcuts (Ctrl+S / Ctrl+F / …) are
 * available while the editor is focused, but yield inside ordinary input
 * controls". Runs against the real jsdom DOM (the vitest environment), so the
 * DOM type narrowing (Element → HTMLElement → isContentEditable) and the
 * `.monaco-editor` `closest()` exemption are exercised for real.
 *
 * Regression surface: every app-global shortcut dispatch in
 * `useAppCommands`' capture-phase keydown listener goes through this
 * predicate first.
 */

/**
 * jsdom does not implement the (rendering-dependent) `isContentEditable`
 * property — it reads as `undefined` even with `contenteditable="true"`.
 * Define it explicitly so the predicate's HTMLElement branch is testable.
 */
function editableDiv(): HTMLDivElement {
  const div = document.createElement("div");
  div.setAttribute("contenteditable", "true");
  Object.defineProperty(div, "isContentEditable", { value: true });
  return div;
}

describe("isEditableTarget", () => {
  it("yields for real form controls: input, textarea, select", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
  });

  it("yields for a contenteditable element", () => {
    expect(isEditableTarget(editableDiv())).toBe(true);
  });

  it("does not yield for ordinary elements (div, body)", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
  });

  it("does not yield for defensive non-Element targets (document itself, null)", () => {
    // The listener lives on `document`; a keydown with nothing focused can
    // report the Document as target, and the spec allows null.
    expect(isEditableTarget(document)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("exempts Monaco's hidden textarea (shortcuts must fire in the editor)", () => {
    // Monaco renders its editable surface as a hidden <textarea class="inputarea">
    // inside `.monaco-editor`. Without the exemption this would return true and
    // every app-global shortcut would die while the editor is focused.
    const host = document.createElement("div");
    host.className = "monaco-editor";
    const monacoTextarea = document.createElement("textarea");
    monacoTextarea.className = "inputarea";
    host.appendChild(monacoTextarea);
    expect(isEditableTarget(monacoTextarea)).toBe(false);

    // The exemption is ancestor-based: any nested target inside the editor
    // (e.g. a gutter widget's contenteditable) is equally exempt.
    expect(isEditableTarget(editableDiv())).toBe(true);
    host.appendChild(editableDiv());
    const nested = host.querySelector<HTMLElement>("[contenteditable='true']");
    expect(nested).not.toBeNull();
    expect(isEditableTarget(nested!)).toBe(false);
  });

  it("does not yield for SVG elements (Element but not HTMLElement)", () => {
    // SVGElement extends Element, not HTMLElement — the isContentEditable
    // lookup must not even be attempted on it.
    const svgRect = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    expect(svgRect).toBeInstanceOf(Element);
    expect(svgRect).not.toBeInstanceOf(HTMLElement);
    expect(isEditableTarget(svgRect)).toBe(false);
  });
});
