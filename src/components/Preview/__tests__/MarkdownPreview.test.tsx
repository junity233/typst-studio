import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 19 only runs `act`'s effect-flushing + warning behavior when this flag
// is set. We render via react-dom/client directly (no @testing-library/react),
// so opt in here. Mirrors ImageViewer.reload.test.tsx / useDebounce.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(source: string, debounceMs?: number): void {
  act(() => {
    root.render(
      <MarkdownPreview source={source} debounceMs={debounceMs} />,
    );
  });
}

describe("MarkdownPreview", () => {
  it("renders markdown source to HTML via the GFM pipeline", () => {
    render("# Hello");
    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe("Hello");
  });

  it("passes the initial source through with no first-frame delay", () => {
    render("first frame");
    expect(container.textContent).toContain("first frame");
  });

  it("lags source updates until the default 150ms debounce elapses", () => {
    render("old");
    render("new");
    // Mid-window: the debounce still shows the OLD value.
    expect(container.textContent).toContain("old");
    expect(container.textContent).not.toContain("new");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(container.textContent).toContain("new");
    expect(container.textContent).not.toContain("old");
  });

  it("honors a custom debounceMs", () => {
    render("old", 50);
    render("new", 50);
    act(() => {
      vi.advanceTimersByTime(49);
    });
    expect(container.textContent).toContain("old");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.textContent).toContain("new");
  });

  it("coalesces a burst of edits into one update on the last value", () => {
    render("a");
    render("b");
    render("c");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Only "c" ever renders — "b" was superseded mid-window, never queued.
    expect(container.textContent).toContain("c");
    expect(container.textContent).not.toContain("a");
  });

  it("renders external links with target=_blank and rel=noopener noreferrer", () => {
    render("[x](https://example.com)");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    // The click routes through the opener mock, never the webview.
    a?.click();
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });
});
