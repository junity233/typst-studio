import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// React 19 only runs `act`'s effect-flushing + warning behavior when this flag
// is set. @testing-library/react sets it automatically; since we render via
// react-dom/client directly, we opt in here so renders/clicks are fully
// flushed before assertions.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { FormatToolbar, dispatchAction } from "../FormatToolbar";
import {
  FORMAT_BUTTON_GROUPS,
  type FormatAction,
  type FormatApi,
  type FormatButton,
} from "../formatActions";
import type { Tab } from "../../../store/tabsStore";

/**
 * Format Toolbar Task 4 — component + dispatch tests.
 *
 * Two layers are pinned:
 *
 *  1. `dispatchAction` (the pure dispatch matrix the component calls). Tested
 *     directly with `vi.fn()` spies so each branch (wrap / replace / linePrefix
 *     / custom) and its argument shape is locked without standing up the
 *     editor. This is the project's preferred pattern (see
 *     `ConflictDialog.test.ts`) — assert on the pure functions the component
 *     reads, not the DOM.
 *
 *  2. The rendered toolbar. `@testing-library/react` isn't a dependency here,
 *     so we render via `react-dom/client`'s `createRoot` (jsdom is configured
 *     globally in `vitest.config.ts`) and assert on the DOM directly. This
 *     pins the structural contract: 15 buttons, 3 dividers, disabled-state
 *     propagation, label-as-title tooltips, and that a click threads through
 *     to the right `FormatApi` method.
 */

// Flatten the table once for lookups.
const ALL_BUTTONS: FormatButton[] = FORMAT_BUTTON_GROUPS.flatMap(
  (g) => g.buttons,
);

// Build a mock FormatApi with vitest spies so each test can assert call args.
const makeMockApi = (): FormatApi & {
  spies: { wrap: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn>; line: ReturnType<typeof vi.fn> };
} => {
  const wrap = vi.fn();
  const replace = vi.fn();
  const line = vi.fn();
  return {
    wrapSelection: wrap,
    replaceSelection: replace,
    toggleLinePrefix: line,
    spies: { wrap, replace, line },
  };
};

const FAKE_TAB = { id: "doc-1", path: null } as unknown as Tab;

// Minimal DOM container + root, with afterEach cleanup to avoid leaking across
// tests (jsdom persists between files but not within a single root).
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (ui: React.ReactElement): HTMLDivElement => {
  container = document.createElement("div");
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(ui);
  });
  return container;
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
};

// ----------------------------------------------------------------------------
// dispatchAction — the pure dispatch matrix
// ----------------------------------------------------------------------------

describe("dispatchAction — per-kind dispatch", () => {
  const ctx = {
    tab: FAKE_TAB,
    workspace: "/ws" as string | null,
    insertImagePathTemplate: undefined,
  };

  it("wrap → calls wrapSelection(prefix, suffix, placeholder)", () => {
    const api = makeMockApi();
    const action: FormatAction = {
      kind: "wrap",
      prefix: "*",
      suffix: "*",
      placeholder: "bold",
    };
    dispatchAction(action, api, ctx);
    expect(api.spies.wrap).toHaveBeenCalledTimes(1);
    expect(api.spies.wrap).toHaveBeenCalledWith("*", "*", "bold");
    expect(api.spies.replace).not.toHaveBeenCalled();
    expect(api.spies.line).not.toHaveBeenCalled();
  });

  it("wrap without placeholder → forwards undefined", () => {
    const api = makeMockApi();
    dispatchAction({ kind: "wrap", prefix: "<", suffix: ">" }, api, ctx);
    expect(api.spies.wrap).toHaveBeenCalledTimes(1);
    expect(api.spies.wrap).toHaveBeenCalledWith("<", ">", undefined);
  });

  it("replace → calls replaceSelection(text)", () => {
    const api = makeMockApi();
    dispatchAction({ kind: "replace", text: "#line(length: 100%)\n" }, api, ctx);
    expect(api.spies.replace).toHaveBeenCalledTimes(1);
    expect(api.spies.replace).toHaveBeenCalledWith("#line(length: 100%)\n");
  });

  it("linePrefix → calls toggleLinePrefix(prefix)", () => {
    const api = makeMockApi();
    dispatchAction({ kind: "linePrefix", prefix: "= " }, api, ctx);
    expect(api.spies.line).toHaveBeenCalledTimes(1);
    expect(api.spies.line).toHaveBeenCalledWith("= ");
  });

  it("custom → invokes run with (api, ctx) and returns void", () => {
    const api = makeMockApi();
    const run = vi.fn();
    dispatchAction({ kind: "custom", run }, api, ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(api, ctx);
    // A custom action drives the editor itself; the generic dispatch must NOT
    // also call the wrap/replace/line methods (would double-apply).
    expect(api.spies.wrap).not.toHaveBeenCalled();
    expect(api.spies.replace).not.toHaveBeenCalled();
    expect(api.spies.line).not.toHaveBeenCalled();
  });

  it("every button's action dispatches exactly one call against the api", () => {
    // For each real button, dispatching should hit exactly one of the three
    // spy methods once (custom hits its own `run`, not the spies).
    for (const button of ALL_BUTTONS) {
      const api = makeMockApi();
      const customRun =
        button.action.kind === "custom" ? button.action.run : undefined;
      const wrapped =
        button.action.kind === "custom"
          ? { ...button.action, run: vi.fn(() => customRun?.(api, ctx)) }
          : button.action;
      dispatchAction(wrapped, api, ctx);
      const total =
        api.spies.wrap.mock.calls.length +
        api.spies.replace.mock.calls.length +
        api.spies.line.mock.calls.length;
      const expectedCustom = button.action.kind === "custom" ? 0 : 1;
      expect(total, `button ${button.id} should fire ${expectedCustom} generic call(s)`).toBe(
        expectedCustom,
      );
    }
  });
});

// ----------------------------------------------------------------------------
// Rendered structure (15 buttons, 3 dividers, labels)
// ----------------------------------------------------------------------------

describe("FormatToolbar — rendered structure", () => {
  beforeEach(cleanup);

  it("renders a toolbar with role=toolbar and the right aria-label", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const toolbar = c.querySelector(".format-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar!.getAttribute("role")).toBe("toolbar");
    expect(toolbar!.getAttribute("aria-label")).toBe("Text formatting");
  });

  it("renders exactly 15 buttons", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const buttons = c.querySelectorAll("button.format-toolbar-button");
    expect(buttons.length).toBe(15);
  });

  it("renders exactly 3 dividers (between 4 groups)", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const dividers = c.querySelectorAll(".format-toolbar-divider");
    expect(dividers.length).toBe(3);
  });

  it("every button carries its label as the title (tooltip)", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const buttons = Array.from(c.querySelectorAll("button.format-toolbar-button"));
    const titles = buttons.map((b) => b.getAttribute("title"));
    const expectedLabels = ALL_BUTTONS.map((b) => b.label);
    expect(titles).toEqual(expectedLabels);
    // aria-label mirrors title for screen readers.
    const ariaLabels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(ariaLabels).toEqual(expectedLabels);
  });

  it("buttons render in the documented group + button order", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const titles = Array.from(
      c.querySelectorAll("button.format-toolbar-button"),
    ).map((b) => b.getAttribute("title"));
    expect(titles).toEqual(ALL_BUTTONS.map((b) => b.label));
  });
});

// ----------------------------------------------------------------------------
// Disabled state
// ----------------------------------------------------------------------------

describe("FormatToolbar — disabled state", () => {
  beforeEach(cleanup);

  it("disables every button when disabled=true", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={true}
      />,
    );
    const buttons = c.querySelectorAll("button.format-toolbar-button");
    expect(buttons.length).toBe(15);
    for (const b of Array.from(buttons)) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("disables every button when api=null (defensive)", () => {
    const c = render(
      <FormatToolbar
        api={null}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const buttons = c.querySelectorAll("button.format-toolbar-button");
    for (const b of Array.from(buttons)) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("enables every button when api + tab present and not disabled", () => {
    const c = render(
      <FormatToolbar
        api={makeMockApi()}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    const buttons = c.querySelectorAll("button.format-toolbar-button");
    for (const b of Array.from(buttons)) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// Click → dispatch wiring (one per kind)
// ----------------------------------------------------------------------------

describe("FormatToolbar — click wires to the right FormatApi method", () => {
  beforeEach(cleanup);

  // Helper: find a button by its label's title attribute and click it.
  const clickByTitle = (container: HTMLElement, title: string) => {
    const btn = container.querySelector<HTMLButtonElement>(
      `button.format-toolbar-button[title="${title}"]`,
    );
    expect(btn, `button titled "${title}" should exist`).not.toBeNull();
    act(() => {
      btn!.click();
    });
  };

  it("Bold (wrap) → wrapSelection('*', '*', 'bold')", () => {
    const api = makeMockApi();
    const c = render(
      <FormatToolbar
        api={api}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    clickByTitle(c, "Bold");
    expect(api.spies.wrap).toHaveBeenCalledTimes(1);
    expect(api.spies.wrap).toHaveBeenCalledWith("*", "*", "bold");
  });

  it("Heading 1 (linePrefix) → toggleLinePrefix('= ')", () => {
    const api = makeMockApi();
    const c = render(
      <FormatToolbar
        api={api}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    clickByTitle(c, "Heading 1");
    expect(api.spies.line).toHaveBeenCalledTimes(1);
    expect(api.spies.line).toHaveBeenCalledWith("= ");
  });

  it("Code block (replace) → replaceSelection('```lang\\n\\n```\\n')", () => {
    const api = makeMockApi();
    const c = render(
      <FormatToolbar
        api={api}
        tab={FAKE_TAB}
        disabled={false}
      />,
    );
    clickByTitle(c, "Code block");
    expect(api.spies.replace).toHaveBeenCalledTimes(1);
    expect(api.spies.replace).toHaveBeenCalledWith("```lang\n\n```\n");
  });

  it("a disabled button does not dispatch", () => {
    const api = makeMockApi();
    const c = render(
      <FormatToolbar
        api={api}
        tab={FAKE_TAB}
        disabled={true}
      />,
    );
    clickByTitle(c, "Bold");
    expect(api.spies.wrap).not.toHaveBeenCalled();
  });
});
