import { useState } from "react";
import type { DirEntry } from "../../lib/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { openFileByPath } from "../../lib/tauri";

/**
 * The workspace file explorer: a lazy, recursively-expandable tree of the open
 * folder. Clicking a `.typ` file opens it as a tab (delegated to `tabsStore`).
 *
 * Browse + open only in this phase. Create / rename / delete / drag land in a
 * later pass (context menu + inline editing).
 */
export function Explorer() {
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const name = useWorkspaceStore((s) => s.name);
  const tree = useWorkspaceStore((s) => s.tree);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const rootEntries = tree[""] ?? [];

  if (rootPath === null) return null;

  return (
    <div className="explorer">
      <div className="explorer-header" title={rootPath}>
        <span className="explorer-title">{name ?? "Workspace"}</span>
      </div>
      <div className="explorer-body">
        {rootEntries.length === 0 ? (
          <p className="explorer-empty">This folder is empty.</p>
        ) : (
          <ul className="tree" role="tree">
            {rootEntries.map((entry) => (
              <TreeRow
                key={entry.relative}
                entry={entry}
                depth={0}
                tree={tree}
                expanded={expanded}
                onToggle={toggleExpand}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface TreeRowProps {
  entry: DirEntry;
  depth: number;
  tree: Record<string, DirEntry[]>;
  expanded: Set<string>;
  onToggle: (rel: string) => Promise<void>;
}

function TreeRow({ entry, depth, tree, expanded, onToggle }: TreeRowProps) {
  const openPath = useTabsStore((s) => s.openPath);
  const activeId = useTabsStore((s) => s.activeId);
  const tabs = useTabsStore((s) => s.tabs);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const [loading, setLoading] = useState(false);

  const isDir = entry.kind === "dir";
  const isOpen = expanded.has(entry.relative);
  const children = isDir ? tree[entry.relative] : undefined;

  // Highlight if this file is the active tab (by absolute path match).
  const isActiveFile =
    !isDir && rootPath !== null && tabs.some(
      (t) => t.id === activeId && t.path === `${rootPath}/${entry.relative}`,
    );

  const handleClick = async () => {
    if (isDir) {
      await onToggle(entry.relative);
      return;
    }
    // Only .typ files are openable as editable sources.
    if (!entry.name.endsWith(".typ")) return;
    if (rootPath === null) return;
    try {
      setLoading(true);
      const abs = `${rootPath}/${entry.relative}`;
      // Avoid reopening a file already open as a tab.
      const existing = useTabsStore.getState().tabs.find((t) => t.path === abs);
      if (existing) {
        useTabsStore.getState().activate(existing.id);
        return;
      }
      const doc = await openFileByPath(abs);
      openPath(doc);
    } catch (e) {
      console.error("[Explorer] open failed:", e);
      window.alert(`Could not open ${entry.name}: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <li role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <div
        className={`tree-row${isActiveFile ? " tree-row-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
        title={entry.relative}
      >
        <span className="tree-twisty">
          {isDir ? (isOpen ? "▾" : "▸") : ""}
        </span>
        <span className={`tree-icon tree-icon-${entry.kind}`}>
          {isDir ? "▹" : "●"}
        </span>
        <span className={`tree-name${entry.name.endsWith(".typ") ? " tree-name-typ" : ""}`}>
          {entry.name}
        </span>
        {loading && <span className="tree-loading" aria-hidden />}
      </div>
      {isDir && isOpen && children && (
        <ul className="tree" role="group">
          {children.map((child) => (
            <TreeRow
              key={child.relative}
              entry={child}
              depth={depth + 1}
              tree={tree}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
