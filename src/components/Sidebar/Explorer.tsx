import { useEffect, useRef, useState } from "react";
import type { DirEntry, EntryKind } from "../../lib/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { openFileByPath } from "../../lib/tauri";

/**
 * The workspace file explorer: a lazy, recursively-expandable tree of the open
 * folder. Supports browse + open (click a `.typ`), and file management via the
 * toolbar (New File / New Folder) and a right-click context menu (Rename /
 * Delete). Renames use an inline editor.
 *
 * Drag-to-move is deferred — create/rename/delete cover the daily cases.
 */
export function Explorer() {
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const name = useWorkspaceStore((s) => s.name);
  const tree = useWorkspaceStore((s) => s.tree);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const createEntry = useWorkspaceStore((s) => s.createEntry);
  const rootEntries = tree[""] ?? [];

  // The directory a "new file/folder" prompt is targeting (relative; "" = root).
  // When set, a TreeRow for that dir renders an inline name input.
  const [pendingNew, setPendingNew] = useState<{ dir: string; kind: EntryKind } | null>(null);

  if (rootPath === null) return null;

  const handleNew = (kind: EntryKind) => {
    // Default target: the root (most common case). A future per-folder "+" would
    // pass a specific dir.
    setPendingNew({ dir: "", kind });
  };

  return (
    <div className="explorer">
      <div className="explorer-header" title={rootPath}>
        <span className="explorer-title">{name ?? "Workspace"}</span>
        <span className="explorer-actions">
          <button
            className="explorer-action"
            title="New file"
            onClick={() => handleNew("file")}
          >
            ＋
          </button>
          <button
            className="explorer-action"
            title="New folder"
            onClick={() => handleNew("dir")}
          >
            ▦
          </button>
        </span>
      </div>
      <div className="explorer-body">
        {rootEntries.length === 0 && pendingNew === null ? (
          <p className="explorer-empty">This folder is empty.</p>
        ) : (
          <ul className="tree" role="tree">
            {/* Inline "new entry" row at the top of the root listing. */}
            {pendingNew?.dir === "" && (
              <NewEntryRow
                kind={pendingNew.kind}
                depth={0}
                onCancel={() => setPendingNew(null)}
                onSubmit={async (entryName) => {
                  await createEntry(entryName, pendingNew.kind);
                  setPendingNew(null);
                }}
              />
            )}
            {rootEntries.map((entry) => (
              <TreeRow
                key={entry.relative}
                entry={entry}
                depth={0}
                tree={tree}
                expanded={expanded}
                onToggle={toggleExpand}
                pendingNew={pendingNew}
                setPendingNew={setPendingNew}
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
  pendingNew: { dir: string; kind: EntryKind } | null;
  setPendingNew: (v: { dir: string; kind: EntryKind } | null) => void;
}

function TreeRow({ entry, depth, tree, expanded, onToggle, pendingNew, setPendingNew }: TreeRowProps) {
  const openPath = useTabsStore((s) => s.openPath);
  const activeId = useTabsStore((s) => s.activeId);
  const tabs = useTabsStore((s) => s.tabs);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const renameEntry = useWorkspaceStore((s) => s.renameEntry);
  const deleteEntry = useWorkspaceStore((s) => s.deleteEntry);
  const createEntry = useWorkspaceStore((s) => s.createEntry);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const isDir = entry.kind === "dir";
  const isOpen = expanded.has(entry.relative);
  const children = isDir ? tree[entry.relative] : undefined;

  const isActiveFile =
    !isDir && rootPath !== null && tabs.some(
      (t) => t.id === activeId && t.path === `${rootPath}/${entry.relative}`,
    );

  const handleClick = async () => {
    if (renaming) return;
    if (isDir) {
      await onToggle(entry.relative);
      return;
    }
    if (!entry.name.endsWith(".typ")) return;
    if (rootPath === null) return;
    try {
      setLoading(true);
      const abs = `${rootPath}/${entry.relative}`;
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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-click = rename (inline edit). Delete is on the row's ✕ button.
    setRenaming(true);
  };

  const handleDelete = async () => {
    const ok = window.confirm(`Delete "${entry.name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await deleteEntry(entry.relative);
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const commitRename = async (newName: string) => {
    setRenaming(false);
    const trimmed = newName.trim();
    if (trimmed === "" || trimmed === entry.name) return;
    const parent = entry.relative.includes("/")
      ? entry.relative.slice(0, entry.relative.lastIndexOf("/"))
      : "";
    const to = parent === "" ? trimmed : `${parent}/${trimmed}`;
    try {
      await renameEntry(entry.relative, to);
    } catch (e) {
      window.alert(`Rename failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <li role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <div
        className={`tree-row${isActiveFile ? " tree-row-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={entry.relative}
      >
        <span className="tree-twisty">
          {isDir ? (isOpen ? "▾" : "▸") : ""}
        </span>
        <span className={`tree-icon tree-icon-${entry.kind}`}>
          {isDir ? "▹" : "●"}
        </span>
        {renaming ? (
          <InlineName
            initial={entry.name}
            onCancel={() => setRenaming(false)}
            onSubmit={commitRename}
          />
        ) : (
          <>
            <span className={`tree-name${entry.name.endsWith(".typ") ? " tree-name-typ" : ""}`}>
              {entry.name}
            </span>
            {loading && <span className="tree-loading" aria-hidden />}
            {!isDir && (
              <button
                className="tree-action"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete();
                }}
              >
                ✕
              </button>
            )}
            {isDir && (
              <>
                <button
                  className="tree-action"
                  title="New file here"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingNew({ dir: entry.relative, kind: "file" });
                  }}
                >
                  ＋
                </button>
                <button
                  className="tree-action"
                  title="Delete folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete();
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </>
        )}
      </div>
      {isDir && isOpen && children && (
        <ul className="tree" role="group">
          {/* Inline "new entry" row inside an expanded directory. */}
          {pendingNew?.dir === entry.relative && (
            <NewEntryRow
              kind={pendingNew.kind}
              depth={depth + 1}
              onCancel={() => setPendingNew(null)}
              onSubmit={async (entryName) => {
                await createEntry(
                  entryName.includes("/")
                    ? entryName
                    : `${entry.relative}/${entryName}`,
                  pendingNew.kind,
                );
                setPendingNew(null);
              }}
            />
          )}
          {children.map((child) => (
            <TreeRow
              key={child.relative}
              entry={child}
              depth={depth + 1}
              tree={tree}
              expanded={expanded}
              onToggle={onToggle}
              pendingNew={pendingNew}
              setPendingNew={setPendingNew}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** An inline text input for creating a new entry or renaming one. */
function InlineName({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="tree-input"
      value={value}
      placeholder="name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(value);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onSubmit(value)}
    />
  );
}

/** A row that prompts for a new file/folder name under a directory. */
function NewEntryRow({
  kind,
  depth,
  onSubmit,
  onCancel,
}: {
  kind: EntryKind;
  depth: number;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <li>
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="tree-twisty" />
        <span className={`tree-icon tree-icon-${kind}`}>
          {kind === "dir" ? "▹" : "●"}
        </span>
        <InlineName
          initial=""
          onCancel={onCancel}
          onSubmit={(v) => {
            void onSubmit(v);
          }}
        />
      </div>
    </li>
  );
}
