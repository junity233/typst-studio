import { describe, it, expect, beforeEach } from "vitest";
import { useDocumentsStore, documentFromOpened } from "../documentsStore";
import type { Document } from "../documentsStore";
import type { LineRect, OpenedDocument, OutlineNode } from "../../lib/types";

/**
 * Unit tests for `documentsStore.setPages` — the FIRST coverage of its two
 * merge paths, which are the core of incremental rendering (§perf):
 *
 * - `full=true` (or the length-mismatch fallback): a fresh array sized to
 *   `pageCount`, filled only from `changedPages`.
 * - `full=false` with matching lengths: `prev.slice()` + index overwrite, so
 *   UNCHANGED pages keep their string reference — the identity contract that
 *   `SvgPage`'s `memo` relies on to skip re-render + blob rebuild.
 *
 * A regression here (e.g. accidentally rebuilding the whole array on every
 * incremental event) would not fail anything visibly — it would just silently
 * re-create every page's blob URL on every compile and make editing large
 * documents janky again. These tests pin that hidden contract, plus the §7
 * stale-revision guard applied to preview events.
 *
 * (The existing `tabsStore.revision.test.ts` only exercises `full=true` and
 * has no identity assertions — the incremental path, the length-mismatch
 * fallback, out-of-range index dropping, and truncation were all uncovered.)
 */

/** Build an `OpenedDocument` payload (as the backend would emit) for seeding. */
function openedDoc(over: Partial<OpenedDocument> = {}): OpenedDocument {
  return {
    content: "= Hi",
    id: "doc-1",
    path: "/x/main.typ",
    title: "main.typ",
    dirty: false,
    origin: { kind: "looseFile", path: "/x/main.typ", root: "/x" },
    revision: 0,
    conflict: "none",
    kind: "typst",
    hidden: false,
    ...over,
  };
}

/**
 * Seed the store with one document, overriding fields (svgPages / revision /
 * compiledRevision) so each test starts from the exact prior-page state it
 * needs. Returns the seeded doc as it lives in the store.
 */
function seed(over: Partial<Document> = {}): Document {
  const doc: Document = { ...documentFromOpened(openedDoc()), ...over };
  useDocumentsStore.setState({ documents: { [doc.id]: doc } });
  return doc;
}

/** Minimal single-entry fixtures for the same-batch `lineMap`/`outline`. */
const LINE_MAP: LineRect[] = [
  { line: 1, page: 0, x: 0, y: 0, w: 100, h: 12 },
];
const OUTLINE: OutlineNode[] = [
  { line: 1, level: 1, title: "Hi", numbering: null, parent: null },
];

const store = () => useDocumentsStore.getState();

describe("setPages: full replace (full=true)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("builds a fresh array sized to pageCount, filled by index", () => {
    seed({ svgPages: ["<svg p0/>"] });
    store().setPages("doc-1", 0, 3, true, [
      { index: 0, svg: "<svg a/>" },
      { index: 1, svg: "<svg b/>" },
      { index: 2, svg: "<svg c/>" },
    ], LINE_MAP, OUTLINE);
    const pages = store().documents["doc-1"].svgPages;
    expect(pages).toEqual(["<svg a/>", "<svg b/>", "<svg c/>"]);
    expect(pages.length).toBe(3);
  });

  it("drops changedPages whose index >= pageCount", () => {
    seed({ svgPages: ["<svg p0/>"] });
    store().setPages("doc-1", 0, 2, true, [
      { index: 0, svg: "<svg a/>" },
      // Out-of-range page from a (defensive) race — must be dropped, not
      // written past the declared pageCount.
      { index: 5, svg: "<svg oob/>" },
    ], LINE_MAP, OUTLINE);
    const pages = store().documents["doc-1"].svgPages;
    expect(pages.length).toBe(2);
    expect(pages[0]).toBe("<svg a/>");
    // Slot 1 was never filled → sparse array hole reads as undefined.
    expect(pages[1]).toBeUndefined();
    expect(pages).not.toContain("<svg oob/>");
  });

  it("truncates when pageCount shrinks below the old array length", () => {
    seed({ svgPages: ["<svg 0/>", "<svg 1/>", "<svg 2/>"] });
    store().setPages("doc-1", 0, 1, true, [
      { index: 0, svg: "<svg new/>" },
    ], LINE_MAP, OUTLINE);
    const pages = store().documents["doc-1"].svgPages;
    expect(pages.length).toBe(1);
    expect(pages[0]).toBe("<svg new/>");
  });
});

describe("setPages: incremental merge (full=false, lengths match)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("keeps unchanged pages' string references (identity), swaps the changed one", () => {
    const seeded = seed({ svgPages: ["<svg a/>", "<svg b/>", "<svg c/>"] });
    const prev = seeded.svgPages;
    store().setPages("doc-1", 0, 3, false, [
      { index: 1, svg: "<svg b2/>" },
    ], LINE_MAP, OUTLINE);
    const pages = store().documents["doc-1"].svgPages;
    // The whole point of incremental rendering: SvgPage's memo compares props
    // by reference, so unchanged pages MUST stay `===` to skip blob rebuild.
    expect(pages[0]).toBe(prev[0]);
    expect(pages[2]).toBe(prev[2]);
    expect(pages[1]).toBe("<svg b2/>");
    expect(pages[1]).not.toBe(prev[1]);
    // (But the array itself is copied — the previous one is untouched.)
    expect(pages).not.toBe(prev);
    expect(prev[1]).toBe("<svg b/>");
  });

  it("handles a multi-page out-of-order update, still preserving the rest", () => {
    const seeded = seed({ svgPages: ["p0", "p1", "p2", "p3", "p4"] });
    const prev = seeded.svgPages;
    store().setPages("doc-1", 0, 5, false, [
      { index: 3, svg: "p3-new" },
      { index: 0, svg: "p0-new" },
    ], LINE_MAP, OUTLINE);
    const pages = store().documents["doc-1"].svgPages;
    expect(pages[0]).toBe("p0-new");
    expect(pages[3]).toBe("p3-new");
    expect(pages[1]).toBe(prev[1]);
    expect(pages[2]).toBe(prev[2]);
    expect(pages[4]).toBe(prev[4]);
  });

  it("falls back to a full rebuild when prev.length !== pageCount", () => {
    // A missed event (or any length desync) must NOT blend mismatched states:
    // the merge degenerates to the full-replace path, where only the slots
    // present in changedPages are filled and the rest are undefined.
    seed({ svgPages: ["p0", "p1", "p2"] });
    store().setPages("doc-1", 0, 2, false, [
      { index: 0, svg: "new-0" },
    ], LINE_MAP, OUTLINE);
    const pages = store().documents["doc-1"].svgPages;
    expect(pages.length).toBe(2);
    expect(pages[0]).toBe("new-0");
    // The stale "p1" from the mismatched old array must NOT leak through.
    expect(pages[1]).toBeUndefined();
  });
});

describe("setPages: §7 revision guard + applied state", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("discards a strictly-older revision (state untouched, same svgPages ref)", () => {
    const seeded = seed({ revision: 3, svgPages: ["cur"] });
    const documentsBefore = useDocumentsStore.getState().documents;
    store().setPages("doc-1", 2, 1, true, [{ index: 0, svg: "stale" }], [], []);
    const after = useDocumentsStore.getState();
    expect(after.documents).toBe(documentsBefore);
    const doc = after.documents["doc-1"];
    expect(doc.svgPages).toBe(seeded.svgPages);
    expect(doc.compiledRevision).toBe(seeded.compiledRevision);
  });

  it("applies when revision === doc.revision, updating compiledRevision + lineMap + outline in one batch", () => {
    seed({ revision: 3, compiledRevision: 2, svgPages: ["stale-preview"] });
    const lineMap: LineRect[] = [
      { line: 4, page: 1, x: 10, y: 20, w: 30, h: 40 },
    ];
    const outline: OutlineNode[] = [
      { line: 1, level: 1, title: "T", numbering: "1.", parent: null },
    ];
    store().setPages("doc-1", 3, 1, true, [{ index: 0, svg: "fresh" }], lineMap, outline);
    const doc = useDocumentsStore.getState().documents["doc-1"];
    expect(doc.svgPages).toEqual(["fresh"]);
    expect(doc.compiledRevision).toBe(3);
    expect(doc.lineMap).toBe(lineMap);
    expect(doc.outline).toBe(outline);
  });

  it("is a no-op for an unknown id (no throw, state unchanged)", () => {
    seed({ svgPages: ["x"] });
    const documentsBefore = useDocumentsStore.getState().documents;
    expect(() =>
      store().setPages("nope", 0, 1, true, [{ index: 0, svg: "y" }], [], []),
    ).not.toThrow();
    expect(useDocumentsStore.getState().documents).toBe(documentsBefore);
  });

  it("integration: a compile tagged with the pre-edit revision is dropped after an edit", () => {
    // §7 end-to-end: open → initial compile lands (rev 0) → the user types
    // (updateContent bumps revision to 1) → the still-in-flight compile of the
    // OLD buffer arrives stamped 0 and must be discarded; only the compile of
    // the new buffer (rev 1) updates the preview.
    store().openDocument(openedDoc());
    store().setPages("doc-1", 0, 2, true, [
      { index: 0, svg: "r0-p0" },
      { index: 1, svg: "r0-p1" },
    ], [], []);
    const afterInitial = useDocumentsStore.getState().documents["doc-1"];
    expect(afterInitial.compiledRevision).toBe(0);

    store().updateContent("doc-1", "= Hi there");
    store().setPages("doc-1", 0, 2, false, [
      { index: 0, svg: "STALE" },
    ], [], []);
    const doc = useDocumentsStore.getState().documents["doc-1"];
    expect(doc.revision).toBe(1);
    expect(doc.svgPages).toEqual(["r0-p0", "r0-p1"]);
    expect(doc.compiledRevision).toBe(0);

    store().setPages("doc-1", 1, 2, false, [
      { index: 0, svg: "fresh-p0" },
    ], [], []);
    const finalDoc = useDocumentsStore.getState().documents["doc-1"];
    expect(finalDoc.svgPages).toEqual(["fresh-p0", "r0-p1"]);
    expect(finalDoc.compiledRevision).toBe(1);
  });
});
