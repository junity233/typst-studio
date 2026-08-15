import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
// Initialize i18next so the modal's translated placeholders/labels resolve to
// their English values (the test queries inputs by placeholder text).
import "../../../i18n";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../../test/react";
import { LinkModal } from "../LinkModal";

/**
 * Format Toolbar Task 6 — link modal tests.
 *
 * The modal is a controlled-by-parent component with two fields (URL required,
 * label optional) and three confirm/cancel paths (Enter, Esc, overlay click).
 * These tests pin each path via direct DOM events (jsdom), since
 * @testing-library/react isn't a dependency. Rendered into document.body via
 * the modal's own portal, so queries go through `document.body`.
 */

// The modal portals into document.body, so queries below go through
// `document.body` rather than the harness container.
const h = reactHarness();

const getUrlInput = () =>
  document.body.querySelector<HTMLInputElement>('input[placeholder="https://example.com"]');
const getLabelInput = () =>
  document.body.querySelector<HTMLInputElement>('input[placeholder="link text"]');
const getInsertBtn = () =>
  document.body.querySelector<HTMLButtonElement>('button[type="submit"]');
const getCancelBtn = () =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent === "Cancel") ?? null;
const getOverlay = () =>
  document.body.querySelector<HTMLDivElement>(".dialog-overlay");

describe("LinkModal", () => {
  afterEach(() => h.cleanup());

  it("renders two inputs and focuses the URL field on mount", () => {
    h.render(<LinkModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(getUrlInput()).not.toBeNull();
    expect(getLabelInput()).not.toBeNull();
    expect(document.activeElement).toBe(getUrlInput());
  });

  it("pre-fills the label from initialLabel", () => {
    h.render(
      <LinkModal initialLabel="selected text" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(getLabelInput()!.value).toBe("selected text");
    // URL starts empty.
    expect(getUrlInput()!.value).toBe("");
  });

  it("Enter with a URL only → onConfirm(url, '') (empty label)", () => {
    const onConfirm = vi.fn();
    h.render(<LinkModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    const input = getUrlInput()!;
    act(() => {
      // React's synthetic onChange needs a native input value set + event.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "https://example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    // Form submit is the path here (Enter in a single-line input submits the
    // form). onConfirm fires with the url + empty trimmed label.
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("https://example.com", "");
  });

  it("URL + label + submit → onConfirm(url, label)", () => {
    const onConfirm = vi.fn();
    h.render(<LinkModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    const urlInput = getUrlInput()!;
    const labelInput = getLabelInput()!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(urlInput, "https://example.com");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      setter.call(labelInput, "click me");
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      getInsertBtn()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith("https://example.com", "click me");
  });

  it("empty URL → submit does NOT call onConfirm", () => {
    const onConfirm = vi.fn();
    h.render(<LinkModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    act(() => {
      getInsertBtn()!.click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("whitespace-only URL → submit does NOT call onConfirm", () => {
    const onConfirm = vi.fn();
    h.render(<LinkModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    const input = getUrlInput()!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "   ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      getInsertBtn()!.click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Esc → onCancel", () => {
    const onCancel = vi.fn();
    h.render(<LinkModal onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => {
      getOverlay()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the overlay → onCancel", () => {
    const onCancel = vi.fn();
    h.render(<LinkModal onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => {
      getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the dialog does NOT cancel", () => {
    const onCancel = vi.fn();
    h.render(<LinkModal onConfirm={vi.fn()} onCancel={onCancel} />);
    const dialog = document.body.querySelector<HTMLDivElement>(".dialog")!;
    act(() => {
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel button → onCancel", () => {
    const onCancel = vi.fn();
    h.render(<LinkModal onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => {
      getCancelBtn()!.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("trims both URL and label on confirm", () => {
    const onConfirm = vi.fn();
    h.render(<LinkModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    const urlInput = getUrlInput()!;
    const labelInput = getLabelInput()!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(urlInput, "  https://example.com  ");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      setter.call(labelInput, "  hi  ");
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      getInsertBtn()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith("https://example.com", "hi");
  });
});
