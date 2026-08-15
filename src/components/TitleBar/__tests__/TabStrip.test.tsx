import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { reactHarness } from "../../../test/react";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  openTab: vi.fn(),
}));

vi.mock("../../../store/tabsStore", () => ({
  useTabsStore: (selector: (state: unknown) => unknown) =>
    selector({
      tabs: ["one", "two", "three"],
      activeId: "two",
      activate: mocks.activate,
      openTab: mocks.openTab,
    }),
}));

vi.mock("../../../store/documentsStore", () => ({
  useDocumentsStore: (selector: (state: unknown) => unknown) =>
    selector({
      documents: {
        one: { title: "One", dirty: false },
        two: { title: "Two", dirty: false },
        three: { title: "Three", dirty: false },
      },
    }),
}));

vi.mock("../../../lib/commands", () => ({
  closeTabWithConfirm: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { title?: string }) =>
      options?.title ?? key,
  }),
}));

import { TabStrip } from "../TabStrip";

const h = reactHarness();

beforeEach(() => {
  mocks.activate.mockReset();
  h.render(<TabStrip />);
});

afterEach(() => {
  h.cleanup();
});

const tabs = () =>
  Array.from(h.container.querySelectorAll<HTMLElement>('[role="tab"]'));

function press(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("TabStrip keyboard navigation", () => {
  it("uses a single roving tab stop", () => {
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves focus and activates with arrows, Home, and End", () => {
    const [one, two, three] = tabs();
    two.focus();

    press(two, "ArrowRight");
    expect(mocks.activate).toHaveBeenLastCalledWith("three");
    expect(document.activeElement).toBe(three);

    press(three, "Home");
    expect(mocks.activate).toHaveBeenLastCalledWith("one");
    expect(document.activeElement).toBe(one);

    press(one, "End");
    expect(mocks.activate).toHaveBeenLastCalledWith("three");
    expect(document.activeElement).toBe(three);
  });

  it("activates the focused tab with Enter or Space", () => {
    const [one] = tabs();

    press(one, "Enter");
    expect(mocks.activate).toHaveBeenLastCalledWith("one");
    press(one, " ");
    expect(mocks.activate).toHaveBeenLastCalledWith("one");
    expect(mocks.activate).toHaveBeenCalledTimes(2);
  });
});
