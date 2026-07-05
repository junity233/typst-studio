/**
 * Outline view (§Outline) — renders the active document's heading tree.
 *
 * The heading tree arrives as a flat `OutlineNode[]` in the `compiled` event
 * payload (built by `render::outline::build_outline` on the backend). Each
 * node carries its absolute `level` and the index of its parent, so this
 * component rebuilds a real tree (not a flat indented list) with expand /
 * collapse, nesting guide lines, and an active-row indicator that tracks the
 * editor's current scroll position (Xcode-navigator style).
 *
 * Design language (DESIGN.md): weight-based hierarchy (H1 caption-strong,
 * deeper levels caption), ink-muted color drift, Action Blue active accent,
 * parchment hover, no chrome shadows, soft guide lines instead of borders.
 *
 * Empty state: "No headings" — shown when the document has no outlineable
 * headings or no document is active.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { editorApiRef } from "../Editor/editorApiRef";
import type { OutlineNode } from "../../lib/types";

/** A tree node with its children resolved from the flat `parent` indices. */
interface TreeNode {
  node: OutlineNode;
  /** Original array index — used as the collapse-set key. */
  index: number;
  children: TreeNode[];
}

/**
 * Rebuild a tree from the flat `OutlineNode[]`. Each node's `parent` is an
 * index into the same array (or null for top-level). We preserve document
 * order: a single left-to-right pass assigns each node to its parent's
 * children array, which keeps the tree ordered exactly as the headings appear.
 */
function buildTree(outline: OutlineNode[]): TreeNode[] {
  const nodes: TreeNode[] = outline.map((node, index) => ({
    node,
    index,
    children: [],
  }));
  const roots: TreeNode[] = [];
  for (const tn of nodes) {
    const parentIdx = tn.node.parent;
    if (parentIdx === null || parentIdx === undefined) {
      roots.push(tn);
    } else {
      // Guard against a stale/invalid parent index (shouldn't happen, but
      // never let a bad payload crash the panel — promote to root).
      const parent = nodes[parentIdx];
      if (parent) parent.children.push(tn);
      else roots.push(tn);
    }
  }
  return roots;
}

/**
 * Collect the indices of every node that has children (i.e. every collapsible
 * node). Used by the "collapse all" toolbar action — folding exactly these
 * hides the whole tree's descendants while keeping every heading reachable
 * (the parent rows stay visible).
 */
function collectInternalIndices(roots: TreeNode[]): number[] {
  const out: number[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const tn of nodes) {
      if (tn.children.length > 0) {
        out.push(tn.index);
        walk(tn.children);
      }
    }
  };
  walk(roots);
  return out;
}

/**
 * Find the index of the heading whose source line is the largest line that is
 * still ≤ `visibleLine` — i.e. the heading currently in view. Returns null if
 * the visible line is before the first heading.
 */
function activeHeadingIndex(outline: OutlineNode[], visibleLine: number): number | null {
  let active: number | null = null;
  for (let i = 0; i < outline.length; i++) {
    if (outline[i].line <= visibleLine) active = i;
    else break;
  }
  return active;
}

export function OutlinePanel() {
  const activeId = useTabsStore((s) => s.activeId);
  const documents = useDocumentsStore((s) => s.documents);

  const outline: OutlineNode[] = activeId
    ? documents[activeId]?.outline ?? []
    : [];

  const tree = useMemo(() => buildTree(outline), [outline]);

  // Collapsed node indices. Defaults to "all expanded" — the outline is for
  // navigation, so users want to see everything by default and collapse
  // sections they're not interested in.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  // Reset collapse state when the document changes (different doc = different
  // tree; stale indices would be meaningless).
  useEffect(() => {
    setCollapsed(new Set());
  }, [activeId]);

  // Track the heading whose source line is currently in view in the editor.
  // We recompute on editor scroll; the value drives the Action Blue active row.
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  useEffect(() => {
    const api = editorApiRef.current;
    if (!api || outline.length === 0) {
      setActiveIdx(null);
      return;
    }
    // Seed from the current visible line, then subscribe to scroll changes.
    const compute = () => {
      const top = api.getTopVisibleLine();
      setActiveIdx(activeHeadingIndex(outline, top));
    };
    compute();
    const unsub = api.onDidScrollChange(compute);
    return unsub;
  }, [outline]);

  const toggle = (index: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  // The internal-node indices are stable for a given tree, so we can derive
  // them once per `tree` change. Toolbar "collapse all" folds every node that
  // has children; "expand all" clears the set.
  const internalIndices = useMemo(() => collectInternalIndices(tree), [tree]);
  const collapseAll = () => setCollapsed(new Set(internalIndices));
  const expandAll = () => setCollapsed(new Set());
  const hasCollapsible = internalIndices.length > 0;
  const allCollapsed =
    hasCollapsible && internalIndices.every((i) => collapsed.has(i));

  const reveal = (line: number) => {
    editorApiRef.current?.revealLine(line, 1);
  };

  if (outline.length === 0) {
    return (
      <div className="outline-empty">
        <div className="outline-empty-glyph">≡</div>
        <div className="outline-empty-text">No headings in this document</div>
        <div className="outline-empty-hint">
          Add headings with <code>=</code>, <code>==</code>, <code>===</code>
        </div>
      </div>
    );
  }

  return (
    <div className="outline-root">
      <div className="tree-toolbar" role="toolbar" aria-label="Outline actions">
        <button
          type="button"
          className="tree-toolbar-btn"
          title="Collapse all"
          aria-label="Collapse all sections"
          disabled={!hasCollapsible || allCollapsed}
          onClick={collapseAll}
        >
          <ChevronsDownUp size={14} />
        </button>
        <button
          type="button"
          className="tree-toolbar-btn"
          title="Expand all"
          aria-label="Expand all sections"
          disabled={collapsed.size === 0}
          onClick={expandAll}
        >
          <ChevronsUpDown size={14} />
        </button>
      </div>
      <div className="outline-tree" role="tree" aria-label="Document outline">
        {tree.map((tn) => (
          <TreeRow
            key={tn.index}
            tn={tn}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            onReveal={reveal}
            activeIdx={activeIdx}
          />
        ))}
      </div>
    </div>
  );
}

interface TreeRowProps {
  tn: TreeNode;
  depth: number;
  collapsed: Set<number>;
  onToggle: (index: number) => void;
  onReveal: (line: number) => void;
  activeIdx: number | null;
}

function TreeRow({ tn, depth, collapsed, onToggle, onReveal, activeIdx }: TreeRowProps) {
  const { node, index, children } = tn;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(index);
  const isActive = activeIdx === index;

  return (
    <>
      <div
        className={[
          "outline-row",
          `outline-level-${Math.min(node.level, 6)}`,
          isActive ? "active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ "--outline-depth": depth } as React.CSSProperties}
        role="treeitem"
        aria-level={node.level}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        aria-selected={isActive}
      >
        {/* Expand/collapse affordance — fixed-width so headings align whether
            or not the node has children. A bare chevron rotates on expand. */}
        <button
          type="button"
          className="outline-twisty"
          tabIndex={-1}
          aria-hidden={!hasChildren}
          disabled={!hasChildren}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(index);
          }}
        >
          {hasChildren && (
            <ChevronRight
              size={12}
              // The icon rotates via CSS (.outline-twisty.expanded > svg) so
              // the transform is GPU-friendly and matches the row's transition.
              className={isCollapsed ? "" : "expanded"}
            />
          )}
        </button>

        {node.numbering && (
          <span className="outline-numbering">{node.numbering}</span>
        )}
        <span
          className="outline-title"
          title={node.title}
          onClick={() => onReveal(node.line)}
        >
          {node.title}
        </span>
      </div>

      {hasChildren && !isCollapsed && (
        <div className="outline-children" role="group">
          {children.map((child) => (
            <TreeRow
              key={child.index}
              tn={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onReveal={onReveal}
              activeIdx={activeIdx}
            />
          ))}
        </div>
      )}
    </>
  );
}
