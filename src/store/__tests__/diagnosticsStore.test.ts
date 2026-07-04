import { describe, it, expect, beforeEach } from "vitest";
import {
  useDiagnosticsStore,
  getCombined,
  selectDiagnosticsForDoc,
  type DocDiagnostics,
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
    const slot: DocDiagnostics = {
      compiler: [diag("c1")],
      tinymist: [],
    };
    expect(getCombined(slot)).toBe(slot.compiler);
  });

  it("returns just tinymist when compiler is empty", () => {
    const slot: DocDiagnostics = {
      compiler: [],
      tinymist: [diag("t1")],
    };
    expect(getCombined(slot)).toBe(slot.tinymist);
  });

  it("concatenates both sources when both are non-empty", () => {
    const slot: DocDiagnostics = {
      compiler: [diag("c1"), diag("c2")],
      tinymist: [diag("t1")],
    };
    const combined = getCombined(slot);
    expect(combined.map((d) => d.message)).toEqual(["c1", "c2", "t1"]);
  });
});

describe("selectDiagnosticsForDoc (§17 testing seam)", () => {
  it("returns the combined view when source is omitted", () => {
    const slot: DocDiagnostics = {
      compiler: [diag("c1")],
      tinymist: [diag("t1")],
    };
    expect(selectDiagnosticsForDoc(slot).map((d) => d.message)).toEqual([
      "c1",
      "t1",
    ]);
  });

  it("returns only the requested source", () => {
    const slot: DocDiagnostics = {
      compiler: [diag("c1")],
      tinymist: [diag("t1")],
    };
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
    const slot: DocDiagnostics = {
      compiler: [diag("c1")],
      tinymist: [],
    };
    expect(selectDiagnosticsForDoc(slot, "tinymist")).toEqual([]);
  });
});
