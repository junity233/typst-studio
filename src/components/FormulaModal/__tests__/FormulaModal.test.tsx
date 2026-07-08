import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// Initialize i18next so the modal's translated labels/placeholders resolve.
import "../../../i18n";
// React 19 only flushes effects under act when this flag is set (matches
// LinkModal.test.tsx / FormatToolbar.test.tsx).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// --- Mocks ------------------------------------------------------------------
// KaTeX renders into the DOM via innerHTML; under jsdom its output is junk, so
// stub it to a no-op. The preview's content is not asserted on — only that the
// modal renders and the insert flow fires the right calls.
vi.mock("katex", () => ({
  default: { render: vi.fn(() => {}) },
}));
// katex.min.css is imported for its side effect; Vite handles it, but jsdom
// test runs don't go through Vite's CSS pipeline — stub the import to avoid a
// resolution error.
vi.mock("katex/dist/katex.min.css", () => ({}));

// `vi.mock` factories are hoisted above all top-level code, so they CANNOT
// reference later `const`s. `vi.hoisted` runs its callback at hoist time and
// returns a stable reference the factories can close over — the sanctioned way
// to share mock state (here: the fake editor + the convert IPC) between the
// factory and the test body.
const { convertMock, fakeEditor } = vi.hoisted(() => ({
  convertMock: vi.fn<(latex: string) => Promise<{ output: string; warnings: never[] }>>(),
  fakeEditor: {
    getCursorPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    getModelLines: vi.fn(() => ["hello"]),
    replaceSelection: vi.fn(),
  },
}));

// The convert IPC is the boundary to the tylax backend; mock it so the test
// pins the modal's insert logic without standing up Tauri.
vi.mock("../../../lib/tauri", () => ({
  convertLatexToTypst: (latex: string) => convertMock(latex),
}));

// `editorApiRef` is a module-scoped mutable ref; the modal reads
// .current at insert time. Mock the module so we can drive a fake editor.
vi.mock("../../Editor/editorApiRef", () => ({
  editorApiRef: { current: fakeEditor, pendingReveal: null },
}));

import { FormulaModal } from "../FormulaModal";
import { useFormulaModalStore } from "../../../store/formulaModalStore";

/**
 * FormulaModal component tests.
 *
 * The modal is store-driven (open/close via useFormulaModalStore) and mounted
 * via a portal to document.body. These tests drive the store to open it, then
 * assert: it renders the LaTeX textarea + preview + buttons, Esc closes it, and
 * a successful insert calls convertLatexToTypst → editorApiRef.replaceSelection
 * with the wrapped Typst math and then closes. KaTeX + the IPC are mocked.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): HTMLElement => {
  container = document.createElement("div");
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(<FormulaModal />);
  });
  return document.body;
};

const cleanup = () => {
  if (root !== null && container !== null) {
    const r = root;
    act(() => {
      r.unmount();
    });
    container.remove();
  }
  root = null;
  container = null;
  // Reset to the closed state. Use the store's own close() so the action
  // methods are preserved (a bare setState with only data fields is also fine
  // since Zustand shallow-merges, but this is unambiguous).
  useFormulaModalStore.getState().close();
};

const getTextarea = () =>
  document.body.querySelector<HTMLTextAreaElement>("textarea.formula-textarea");
const getOverlay = () =>
  document.body.querySelector<HTMLDivElement>(".dialog-overlay");
const getInsertBtn = () =>
  document.body.querySelector<HTMLButtonElement>("button.btn-primary");
const getCancelBtn = () =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent === "Cancel") ?? null;

describe("FormulaModal", () => {
  beforeEach(() => {
    convertMock.mockReset();
    convertMock.mockResolvedValue({ output: "a/b", warnings: [] });
    fakeEditor.getCursorPosition.mockReset().mockReturnValue({ lineNumber: 1, column: 1 });
    fakeEditor.getModelLines.mockReset().mockReturnValue(["hello"]);
    fakeEditor.replaceSelection.mockReset();
    cleanup();
  });
  afterEach(cleanup);

  it("renders nothing when the store is closed", () => {
    render();
    expect(getTextarea()).toBeNull();
  });

  it("renders the textarea + preview + insert button when opened", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    expect(getTextarea()).not.toBeNull();
    expect(document.body.querySelector(".formula-preview")).not.toBeNull();
    expect(getInsertBtn()).not.toBeNull();
  });

  it("autofocuses the textarea on open", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    // The focus is set on a setTimeout(0) in the open effect; flush it.
    return new Promise<void>((resolve) => {
      window.setTimeout(() => {
        resolve();
      }, 0);
    }).then(() => {
      expect(document.activeElement).toBe(getTextarea());
    });
  });

  it("seeds the textarea from the store's initialLatex", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open("\\frac{a}{b}");
    });
    expect(getTextarea()!.value).toBe("\\frac{a}{b}");
  });

  it("Esc closes the modal", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    act(() => {
      getOverlay()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(useFormulaModalStore.getState().isOpen).toBe(false);
  });

  it("clicking the overlay closes the modal", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    act(() => {
      getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useFormulaModalStore.getState().isOpen).toBe(false);
  });

  it("Cancel button closes the modal", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    act(() => {
      getCancelBtn()!.click();
    });
    expect(useFormulaModalStore.getState().isOpen).toBe(false);
  });

  it("empty input disables the insert button", () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    expect(getInsertBtn()!.disabled).toBe(true);
  });

  it("typing LaTeX + Insert → converts, wraps inline, inserts at cursor, closes", async () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    const ta = getTextarea()!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, "\\frac{a}{b}");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Cursor at (1,1) in ["hello"] → markup context → inline wraps `$…$`.
    await act(async () => {
      getInsertBtn()!.click();
    });
    expect(convertMock).toHaveBeenCalledWith("\\frac{a}{b}");
    expect(fakeEditor.replaceSelection).toHaveBeenCalledWith("$a/b$");
    expect(useFormulaModalStore.getState().isOpen).toBe(false);
  });

  it("display mode wraps as `$ … $`", async () => {
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    const ta = getTextarea()!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, "x^2");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Switch to display mode.
    const displayBtn = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".formula-mode-btn"),
    ).find((b) => b.textContent === "Display")!;
    act(() => {
      displayBtn.click();
    });
    // Make the convert mock echo the converted body for x^2 so the assertion
    // is self-consistent (the default mock returns "a/b").
    convertMock.mockResolvedValue({ output: "x^2", warnings: [] });
    await act(async () => {
      getInsertBtn()!.click();
    });
    expect(fakeEditor.replaceSelection).toHaveBeenCalledWith("$ x^2 $");
  });

  it("inside math context: inserts the body bare (no `$`)", async () => {
    // Line 1 has ONE unescaped `$` (an unclosed math region) → an odd dollar
    // count → the cursor on line 2 is in math mode. (A closed `$x$` would be
    // 2 dollars = even = markup, which is the inline/display-wrap path.)
    fakeEditor.getCursorPosition.mockReturnValue({ lineNumber: 2, column: 1 });
    fakeEditor.getModelLines.mockReturnValue(["$x + ", ""]);
    // Echo the converted body for "+1" so the bare-insert assertion holds.
    convertMock.mockResolvedValue({ output: "+1", warnings: [] });
    render();
    act(() => {
      useFormulaModalStore.getState().open();
    });
    const ta = getTextarea()!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, "+1");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      getInsertBtn()!.click();
    });
    // Bare body — cursor is already inside `$…$`.
    expect(fakeEditor.replaceSelection).toHaveBeenCalledWith("+1");
  });

  it("no active editor: shows an error and does not insert", async () => {
    // Temporarily null out the editor ref for this case only.
    const mod = await import("../../Editor/editorApiRef");
    const saved = mod.editorApiRef.current;
    mod.editorApiRef.current = null;
    try {
      render();
      act(() => {
        useFormulaModalStore.getState().open();
      });
      const ta = getTextarea()!;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(ta, "x");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        getInsertBtn()!.click();
      });
      expect(fakeEditor.replaceSelection).not.toHaveBeenCalled();
      // Modal stays open so the user sees the error.
      expect(useFormulaModalStore.getState().isOpen).toBe(true);
      expect(document.body.querySelector(".formula-error")).not.toBeNull();
    } finally {
      mod.editorApiRef.current = saved;
    }
  });
});
