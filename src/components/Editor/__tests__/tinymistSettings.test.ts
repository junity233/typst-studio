import { describe, expect, it } from "vitest";
import { buildTinymistSettings } from "../tinymistSettings";

describe("buildTinymistSettings", () => {
  it("wraps the formatter mode in the tinymist section", () => {
    expect(buildTinymistSettings("typstyle", 0)).toEqual({
      tinymist: { formatterMode: "typstyle" },
    });
    expect(buildTinymistSettings("typstfmt", 0)).toEqual({
      tinymist: { formatterMode: "typstfmt" },
    });
  });

  it("falls back to typstyle for unknown values (the server default)", () => {
    expect(buildTinymistSettings("bogus", 0)).toEqual({
      tinymist: { formatterMode: "typstyle" },
    });
    expect(buildTinymistSettings("", 0)).toEqual({
      tinymist: { formatterMode: "typstyle" },
    });
  });

  it("forwards a positive print width (floored), omits it otherwise", () => {
    expect(buildTinymistSettings("typstyle", 80)).toEqual({
      tinymist: { formatterMode: "typstyle", formatterPrintWidth: 80 },
    });
    expect(buildTinymistSettings("typstyle", 80.7)).toEqual({
      tinymist: { formatterMode: "typstyle", formatterPrintWidth: 80 },
    });
    // 0 / negative / NaN = "unset" → key absent, server default applies.
    expect(buildTinymistSettings("typstyle", 0).tinymist).not.toHaveProperty(
      "formatterPrintWidth",
    );
    expect(buildTinymistSettings("typstyle", -5).tinymist).not.toHaveProperty(
      "formatterPrintWidth",
    );
    expect(buildTinymistSettings("typstyle", NaN).tinymist).not.toHaveProperty(
      "formatterPrintWidth",
    );
  });
});
