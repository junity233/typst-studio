import { describe, it, expect, beforeEach } from "vitest";
import {
  useDiagnosticsStore,
  getCombined,
  selectDiagnosticsForDoc,
  dedupDiagnostics,
  makeDoc,
} from "../diagnosticsStore";
import type { Diagnostic } from "../../lib/types";

/**
 * diagnosticsStore (spec §13.1 / §17): per-document diagnostics split by
 * source (compiler / tinymist). The two sources must coexist without
 * overwriting each other, and the combined selector concatenates them.
 */

function diag(
  message: string,
  over: Partial<Diagnostic> = {},
): Diagnostic {
  return {
    severity: "Error",
    message,
    code: null,
    range: {
      start_line: 1,
      start_column: 1,
      end_line: 1,
      end_column: 2,
    },
    ...over,
  };
}

describe("diagnosticsStore (§13.1)", () => {
  beforeEach(() => {
    // Reset to a clean store between tests.
    useDiagnosticsStore.setState({ byDoc: {} });
  });

  it("set writes the compiler source without touching tinymist", () => {
    useDiagnosticsStore.getState().set("d1", "compiler", [diag("c1")]);
    const slot = useDiagnosticsStore.getState().byDoc.d1;
    expect(slot).toBeDefined();
    expect(slot.compiler).toHaveLength(1);
    expect(slot.compiler[0].message).toBe("c1");
    // tinymist slot exists but is empty.
    expect(slot.tinymist).toEqual([]);
  });

  it("set writes the tinymist source without touching compiler", () => {
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t1")]);
    const slot = useDiagnosticsStore.getState().byDoc.d1;
    expect(slot.tinymist).toHaveLength(1);
    expect(slot.compiler).toEqual([]);
  });

  it("compiler and tinymist coexist — neither overwrites the other (§13.1)", () => {
    useDiagnosticsStore.getState().set("d1", "compiler", [diag("c1")]);
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t1")]);
    const slot = useDiagnosticsStore.getState().byDoc.d1;
    expect(slot.compiler.map((d) => d.message)).toEqual(["c1"]);
    expect(slot.tinymist.map((d) => d.message)).toEqual(["t1"]);
  });

  it("clear removes only one source", () => {
    useDiagnosticsStore.getState().set("d1", "compiler", [diag("c1")]);
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t1")]);

    useDiagnosticsStore.getState().clear("d1", "tinymist");
    const slot = useDiagnosticsStore.getState().byDoc.d1;
    expect(slot.compiler).toHaveLength(1);
    expect(slot.tinymist).toEqual([]);
  });

  it("clear drops the entry entirely when both sources become empty", () => {
    useDiagnosticsStore.getState().set("d1", "compiler", [diag("c1")]);
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t1")]);

    useDiagnosticsStore.getState().clear("d1", "compiler");
    // tinymist still has data → entry remains.
    expect(useDiagnosticsStore.getState().byDoc.d1).toBeDefined();

    useDiagnosticsStore.getState().clear("d1", "tinymist");
    // Both empty now → entry removed.
    expect(useDiagnosticsStore.getState().byDoc.d1).toBeUndefined();
  });

  it("clearAll removes both sources at once (used by tabsStore.closeTab)", () => {
    useDiagnosticsStore.getState().set("d1", "compiler", [diag("c1")]);
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t1")]);

    useDiagnosticsStore.getState().clearAll("d1");
    expect(useDiagnosticsStore.getState().byDoc.d1).toBeUndefined();
  });

  it("clearAll on an unknown id is a no-op", () => {
    const before = useDiagnosticsStore.getState().byDoc;
    useDiagnosticsStore.getState().clearAll("never-opened");
    expect(useDiagnosticsStore.getState().byDoc).toBe(before);
  });

  it("replacing a source does not mutate the other source's array reference", () => {
    useDiagnosticsStore.getState().set("d1", "compiler", [diag("c1")]);
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t1")]);
    const compilerRefBefore =
      useDiagnosticsStore.getState().byDoc.d1.compiler;

    // Re-publish tinymist — compiler's array reference must stay stable.
    useDiagnosticsStore.getState().set("d1", "tinymist", [diag("t2")]);
    expect(useDiagnosticsStore.getState().byDoc.d1.compiler).toBe(
      compilerRefBefore,
    );
  });
});

describe("getCombined (§13.1)", () => {
  it("returns an empty array for an undefined slot", () => {
    expect(getCombined(undefined)).toEqual([]);
  });

  it("returns just compiler when tinymist is empty", () => {
    const slot = makeDoc([diag("c1")], []);
    expect(getCombined(slot)).toBe(slot.compiler);
  });

  it("returns just tinymist when compiler is empty", () => {
    const slot = makeDoc([], [diag("t1")]);
    expect(getCombined(slot)).toBe(slot.tinymist);
  });

  it("concatenates both sources when both are non-empty", () => {
    const slot = makeDoc([diag("c1"), diag("c2")], [diag("t1")]);
    const combined = getCombined(slot);
    expect(combined.map((d) => d.message)).toEqual(["c1", "c2", "t1"]);
  });
});

describe("selectDiagnosticsForDoc (§17 testing seam)", () => {
  it("returns the combined view when source is omitted", () => {
    const slot = makeDoc([diag("c1")], [diag("t1")]);
    expect(selectDiagnosticsForDoc(slot).map((d) => d.message)).toEqual([
      "c1",
      "t1",
    ]);
  });

  it("returns only the requested source", () => {
    const slot = makeDoc([diag("c1")], [diag("t1")]);
    expect(selectDiagnosticsForDoc(slot, "compiler").map((d) => d.message))
      .toEqual(["c1"]);
    expect(selectDiagnosticsForDoc(slot, "tinymist").map((d) => d.message))
      .toEqual(["t1"]);
  });

  it("returns an empty array (never undefined) for an absent slot", () => {
    expect(selectDiagnosticsForDoc(undefined)).toEqual([]);
    expect(selectDiagnosticsForDoc(undefined, "compiler")).toEqual([]);
  });

  it("returns an empty array when the requested source is empty", () => {
    const slot = makeDoc([diag("c1")], []);
    expect(selectDiagnosticsForDoc(slot, "tinymist")).toEqual([]);
  });
});

describe("dedupDiagnostics — collapse compiler/tinymist duplicates", () => {
  it("collapses identical diagnostics (same severity + range + message)", () => {
    // The common case: the native compiler and tinymist both report the same
    // Typst error at the same position. Must collapse to ONE entry.
    const a = diag("expected expression");
    const b = diag("expected expression"); // structurally identical to `a`
    const out = dedupDiagnostics([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("expected expression");
  });

  it("keeps diagnostics that differ by message", () => {
    const out = dedupDiagnostics([
      diag("error one"),
      diag("error two"),
    ]);
    expect(out.map((d) => d.message)).toEqual(["error one", "error two"]);
  });

  it("keeps diagnostics that differ by range", () => {
    const out = dedupDiagnostics([
      diag("same msg", { range: { start_line: 1, start_column: 1, end_line: 1, end_column: 2 } }),
      diag("same msg", { range: { start_line: 5, start_column: 1, end_line: 5, end_column: 2 } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps diagnostics that differ by severity", () => {
    const out = dedupDiagnostics([
      diag("same msg", { severity: "Error" }),
      diag("same msg", { severity: "Warning" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.severity)).toEqual(["Error", "Warning"]);
  });

  it("does NOT dedup by code — same position/message but different code stays", () => {
    // Two sources may phrase the same error with different codes; collapsing on
    // code would be wrong (the position+message is the identity).
    const out = dedupDiagnostics([
      diag("m", { code: 1n }),
      diag("m", { code: 2n }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("is stable: keeps the FIRST occurrence (compiler wins over tinymist)", () => {
    // getCombined orders compiler before tinymist, so a compiler diagnostic is
    // preserved over its tinymist duplicate.
    const compiler = diag("dup", { code: 100n });
    const tinymist = diag("dup", { code: null });
    const out = dedupDiagnostics([compiler, tinymist]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(compiler); // identity preserved
  });

  it("passes through arrays of length 0 or 1 unchanged", () => {
    expect(dedupDiagnostics([])).toEqual([]);
    const single = [diag("only")];
    expect(dedupDiagnostics(single)).toEqual(single);
  });

  it("handles multiple duplicates interspersed with uniques", () => {
    const out = dedupDiagnostics([
      diag("a"),
      diag("b"),
      diag("a"), // dup of first
      diag("c"),
      diag("b"), // dup of second
    ]);
    expect(out.map((d) => d.message)).toEqual(["a", "b", "c"]);
  });
});

describe("getCombined dedup behavior", () => {
  it("deduplicates compiler + tinymist overlap", () => {
    const slot = makeDoc(
      [diag("shared"), diag("only-compiler")],
      [diag("shared"), diag("only-tinymist")],
    );
    const combined = getCombined(slot);
    expect(combined.map((d) => d.message)).toEqual([
      "shared",
      "only-compiler",
      "only-tinymist",
    ]);
  });

  it("still returns the source array reference when only one source is populated (no dedup cost)", () => {
    const slot = makeDoc([diag("c1"), diag("c1")], []); // intra-source dup, single source
    // Single-source path returns the raw array (intra-source dedup is NOT
    // applied — only cross-source overlap is collapsed).
    expect(getCombined(slot)).toBe(slot.compiler);
  });

  it("returns a STABLE reference for the same (compiler, tinymist) pair (zustand getSnapshot)", () => {
    // The infinite-loop bug: getCombined must return the SAME reference for the
    // same inputs, else useSyncExternalStore detects a changing snapshot and
    // re-renders forever. The cached `combined` field guarantees this.
    const slot = makeDoc([diag("a"), diag("b")], [diag("c")]);
    expect(getCombined(slot)).toBe(getCombined(slot));
    expect(getCombined(slot)).toBe(slot.combined);
  });
});
