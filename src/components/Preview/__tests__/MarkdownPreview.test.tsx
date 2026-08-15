import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../../test/react";

// `MarkdownLink` routes external links through the opener plugin; mock it so a
// stray click (or import-time IPC) never reaches the Tauri bridge.
const openUrlMock = vi.fn<(url: string | URL) => Promise<void>>();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string | URL) => openUrlMock(url),
}));

import { MarkdownPreview } from "../MarkdownPreview";

/**
 * First component tests for `MarkdownPreview` — the ONLY preview path for
 * `DocumentKind === "markdown"` tabs (consumed by EditorArea). Two user-visible
 * behaviors are pinned:
 *
 * 1. The debounce must lag (never block) the preview: edits show up after the
 *    quiet period, exactly once per burst, on the LAST value. This is now the
 *    shared `useDebounce` hook — the last hand-rolled copy was removed here —
 *    so these tests also guard the wiring (initial value passes through with
 *    no first-frame delay).
 * 2. External links are rendered with `target=_blank` +
 *    `rel="noopener noreferrer"` and never navigate the webview (security /
 *    CSP behavior shared via `MarkdownLink`).
 *
 * Driven with fake timers; every `advanceTimersByTime` that can flush a
 * `setState` runs inside `act`.
 */

const h = reactHarness();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  h.cleanup();
  vi.useRealTimers();
});

describe("MarkdownPreview", () => {
  it("renders markdown source to HTML via the GFM pipeline", () => {
    h.render(<MarkdownPreview source="# Hello" />);
    const h1 = h.container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe("Hello");
  });

  it("passes the initial source through with no first-frame delay", () => {
    h.render(<MarkdownPreview source="first frame" />);
    expect(h.container.textContent).toContain("first frame");
  });

  it("lags source updates until the default 150ms debounce elapses", () => {
    h.render(<MarkdownPreview source="old" />);
    h.rerender(<MarkdownPreview source="new" />);
    // Mid-window: the debounce still shows the OLD value.
    expect(h.container.textContent).toContain("old");
    expect(h.container.textContent).not.toContain("new");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(h.container.textContent).toContain("new");
    expect(h.container.textContent).not.toContain("old");
  });

  it("honors a custom debounceMs", () => {
    h.render(<MarkdownPreview source="old" debounceMs={50} />);
    h.rerender(<MarkdownPreview source="new" debounceMs={50} />);
    act(() => {
      vi.advanceTimersByTime(49);
    });
    expect(h.container.textContent).toContain("old");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(h.container.textContent).toContain("new");
  });

  it("coalesces a burst of edits into one update on the last value", () => {
    h.render(<MarkdownPreview source="a" />);
    h.rerender(<MarkdownPreview source="b" />);
    h.rerender(<MarkdownPreview source="c" />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Only "c" ever renders — "b" was superseded mid-window, never queued.
    expect(h.container.textContent).toContain("c");
    expect(h.container.textContent).not.toContain("a");
  });

  it("renders external links with target=_blank and rel=noopener noreferrer", () => {
    h.render(<MarkdownPreview source="[x](https://example.com)" />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const a = h.container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    // The click routes through the opener mock, never the webview.
    a?.click();
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });
});
