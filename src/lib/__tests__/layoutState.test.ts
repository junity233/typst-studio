import { describe, expect, it } from "vitest";

import { captureLayout, effectiveLayout } from "../layoutState";

describe("captureLayout", () => {
  it("passes visibility flags and numeric widths through unchanged", () => {
    expect(
      captureLayout({
        sidebarVisible: true,
        previewVisible: false,
        diagnosticsVisible: true,
        sidebarWidth: 240,
        previewWidth: 480,
      }),
    ).toEqual({
      sidebarVisible: true,
      previewVisible: false,
      diagnosticsVisible: true,
      sidebarWidth: 240,
      previewWidth: 480,
    });
  });

  it("normalizes missing pane widths to null", () => {
    expect(
      captureLayout({
        sidebarVisible: false,
        previewVisible: true,
        diagnosticsVisible: false,
        sidebarWidth: undefined,
        previewWidth: null,
      }),
    ).toEqual({
      sidebarVisible: false,
      previewVisible: true,
      diagnosticsVisible: false,
      sidebarWidth: null,
      previewWidth: null,
    });
  });
});

describe("effectiveLayout", () => {
  it("falls back per-field when the session has no layout", () => {
    expect(
      effectiveLayout(null, {
        sidebarVisible: true,
        previewVisible: false,
        diagnosticsVisible: true,
      }),
    ).toEqual({
      sidebarVisible: true,
      previewVisible: false,
      diagnosticsVisible: true,
      sidebarWidth: null,
      previewWidth: null,
    });
  });

  it("treats a missing fallback diagnosticsVisible as false", () => {
    const layout = effectiveLayout(null, {
      sidebarVisible: false,
      previewVisible: false,
    });
    expect(layout.diagnosticsVisible).toBe(false);
  });

  it("lets the session win per-field, including null widths", () => {
    expect(
      effectiveLayout(
        {
          sidebarVisible: false,
          previewVisible: true,
          diagnosticsVisible: false,
          sidebarWidth: 320,
          previewWidth: null,
        },
        { sidebarVisible: true, previewVisible: false, diagnosticsVisible: true },
      ),
    ).toEqual({
      sidebarVisible: false,
      previewVisible: true,
      diagnosticsVisible: false,
      sidebarWidth: 320,
      previewWidth: null,
    });
  });

  it("keeps an explicit session false over a fallback true", () => {
    const layout = effectiveLayout(
      {
        sidebarVisible: true,
        previewVisible: true,
        diagnosticsVisible: false,
      },
      { sidebarVisible: false, previewVisible: false, diagnosticsVisible: true },
    );
    expect(layout.diagnosticsVisible).toBe(false);
  });
});
