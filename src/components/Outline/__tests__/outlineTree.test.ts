import { describe, it, expect } from "vitest";
import type { OutlineNode } from "../../../lib/types";
import {
  activeHeadingIndex,
  buildTree,
  collectInternalIndices,
} from "../OutlinePanel";

/**
 * Unit tests for the Outline panel's tree-building pure functions — the FIRST
 * coverage for this module. The flat `OutlineNode[]` (with per-node `parent`
 * indices) arrives from the backend `compiled` event (built by
 * `render/outline.rs`), so these tests pin the exact payload contract the two
 * sides share: if the backend ever changes the `parent` index convention, the
 * frontend would silently scramble the tree rather than error — these tests are
 * what catches that.
 *
 * - `buildTree`: flat→tree rebuild, document order, and the bad-payload guard
 *   (out-of-bounds parent promotes to root instead of crashing the panel).
 * - `collectInternalIndices`: the "collapse all" action's target set.
 * - `activeHeadingIndex`: the Action Blue active-row indicator's scroll rule.
 */

/** Build an `OutlineNode`; `parent` indexes the enclosing array, null = root. */
function node(
  line: number,
  parent: number | null,
  level = 1,
  title = `L${line}`,
): OutlineNode {
  return { line, level, title, numbering: null, parent };
}

describe("buildTree", () => {
  it("returns no roots for an empty outline", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("treats every null-parent node as a root, in document order", () => {
    const outline = [node(1, null), node(5, null), node(9, null)];
    const roots = buildTree(outline);
    expect(roots.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it("rebuilds a classic two-level nesting", () => {
    // A(root) ← B, C; B ← D.
    const outline = [
      node(1, null, 1, "A"),
      node(2, 0, 2, "B"),
      node(3, 0, 2, "C"),
      node(4, 1, 3, "D"),
    ];
    const roots = buildTree(outline);
    expect(roots.length).toBe(1);
    expect(roots[0].node.title).toBe("A");
    expect(roots[0].children.map((c) => c.node.title)).toEqual(["B", "C"]);
    expect(roots[0].children[0].children.map((c) => c.node.title)).toEqual([
      "D",
    ]);
  });

  it("treats a missing (undefined) parent the same as null (root)", () => {
    // The backend serializes `None` as null, but a hand-rolled or corrupted
    // payload may omit the field entirely — both must land at top level.
    const outline = [
      { line: 1, level: 1, title: "A", numbering: null },
      node(2, 0, 2, "B"),
    ];
    const roots = buildTree(outline as OutlineNode[]);
    expect(roots.length).toBe(1);
    expect(roots[0].children.map((c) => c.node.title)).toEqual(["B"]);
  });

  it("promotes a node with an out-of-bounds parent index to root (bad payload guard)", () => {
    // Node 0 points at the non-existent nodes[99] → promoted to root; node 1
    // has a VALID parent (0) and must still attach to it.
    const outline = [node(1, 99), node(2, 0)];
    const roots = buildTree(outline);
    expect(roots.map((r) => r.index)).toEqual([0]);
    expect(roots[0].children.map((c) => c.index)).toEqual([1]);
  });

  it("promotes EVERY orphan when the parent index is out of bounds", () => {
    const outline = [node(1, 99), node(2, 42)];
    const roots = buildTree(outline);
    expect(roots.map((r) => r.index)).toEqual([0, 1]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it("keeps children in their original array order", () => {
    const outline = [
      node(1, null, 1, "A"),
      node(10, 0, 2, "B1"),
      node(20, 0, 2, "B2"),
      node(30, 0, 2, "B3"),
    ];
    const roots = buildTree(outline);
    expect(roots[0].children.map((c) => c.node.title)).toEqual([
      "B1",
      "B2",
      "B3",
    ]);
  });
});

describe("collectInternalIndices", () => {
  it("collects only nodes that have children (leaves are excluded)", () => {
    // A(internal) ← B(leaf), C(internal) ← D(leaf).
    const outline = [node(1, null), node(2, 0), node(3, 0), node(4, 2)];
    const roots = buildTree(outline);
    expect(collectInternalIndices(roots).sort()).toEqual([0, 2]);
  });

  it("collects deep internal nodes too (recursive walk)", () => {
    // A ← B ← C ← D(leaf): A, B, C are all internal.
    const outline = [node(1, null), node(2, 0), node(3, 1), node(4, 2)];
    const roots = buildTree(outline);
    expect(collectInternalIndices(roots)).toEqual([0, 1, 2]);
  });

  it("returns an empty list for empty roots (nothing collapsible)", () => {
    expect(collectInternalIndices([])).toEqual([]);
  });
});

describe("activeHeadingIndex", () => {
  const outline = [
    node(10, null),
    node(30, null),
    node(50, null),
  ];

  it("returns null when the visible line is before the first heading", () => {
    expect(activeHeadingIndex(outline, 5)).toBeNull();
  });

  it("returns the heading whose line exactly matches the visible line", () => {
    expect(activeHeadingIndex(outline, 30)).toBe(1);
  });

  it("returns the last heading at or above the visible line when in between", () => {
    expect(activeHeadingIndex(outline, 35)).toBe(1);
    expect(activeHeadingIndex(outline, 29)).toBe(0);
  });

  it("clamps to the last heading when the visible line is past the end", () => {
    expect(activeHeadingIndex(outline, 500)).toBe(2);
  });

  it("returns null for an empty outline", () => {
    expect(activeHeadingIndex([], 100)).toBeNull();
  });
});
