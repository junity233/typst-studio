import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import type { DirEntry, EntryKind } from "../../lib/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore, readOrderedDocuments } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { openFileByPath, revealInFinder } from "../../lib/tauri";
import { useContextMenuStore } from "./contextMenuStore";

const ICON_SIZE = 14;

/**
 * The workspace file explorer: a lazy, recursively-expandable tree of the open
 * folder. Supports browse + open (click a `.typ`), file management via the
 * toolbar (New File / New Folder) and a real right-click context menu
 * (Rename / Delete / Copy / Reveal / Collapse-all). Renames use an inline
 * editor. Folders expand/collapse with a CSS grid height transition.
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
  const collapseAll = useWorkspaceStore((s) => s.collapseAll);
  const expandAll = useWorkspaceStore((s) => s.expandAll);
  const openMenu = useContextMenuStore((s) => s.open);
  const rootEntries = tree[""] ?? [];

  // The directory a "new file/folder" prompt is targeting (relative; "" = root).
  // When set, a TreeRow for that dir renders an inline name input.
  const [pendingNew, setPendingNew] = useState<{ dir: string; kind: EntryKind } | null>(null);

  if (rootPath === null) return null;

  const handleNew = (kind: EntryKind) => {
    setPendingNew({ dir: "", kind });
  };

  const handleBodyContextMenu = (e: React.MouseEvent) => {
    // Right-click on empty space (not on a row — rows stopPropagation).
    e.preventDefault();
    openMenu(
      [
        {
          type: "action",
          label: "New File",
          icon: <FilePlus size={ICON_SIZE} />,
          onSelect: () => handleNew("file"),
        },
        {
          type: "action",
          label: "New Folder",
          icon: <FolderPlus size={ICON_SIZE} />,
          onSelect: () => handleNew("dir"),
        },
        { type: "separator" },
        {
          type: "action",
          label: "Collapse All",
          icon: <ChevronsDownUp size={ICON_SIZE} />,
          onSelect: () => void collapseAll(),
        },
        {
          type: "action",
          label: "Expand All",
          icon: <ChevronsUpDown size={ICON_SIZE} />,
          onSelect: () => void expandAll(),
        },
      ],
      e.clientX,
      e.clientY,
    );
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
            <FilePlus size={14} />
          </button>
          <button
            className="explorer-action"
            title="New folder"
            onClick={() => handleNew("dir")}
          >
            <FolderPlus size={14} />
          </button>
        </span>
      </div>
      <div className="explorer-body" onContextMenu={handleBodyContextMenu}>
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
  // Subscribe to the documents map so the active-file highlight tracks path
  // changes (e.g. after Save As) and dirty/open state.
  const documents = useDocumentsStore((s) => s.documents);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const renameEntry = useWorkspaceStore((s) => s.renameEntry);
  const deleteEntry = useWorkspaceStore((s) => s.deleteEntry);
  const createEntry = useWorkspaceStore((s) => s.createEntry);
  const openMenu = useContextMenuStore((s) => s.open);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const isDir = entry.kind === "dir";
  const isOpen = expanded.has(entry.relative);
  // `children` is undefined until the dir has been loaded at least once.
  // We keep the animated container mounted whenever children are loaded, so
  // the open/close transition has real content to animate over.
  const children = isDir ? tree[entry.relative] : undefined;

  const isActiveFile =
    !isDir &&
    rootPath !== null &&
    activeId !== null &&
    documents[activeId]?.path === `${rootPath}/${entry.relative}`;

  // Folders expand/collapse on single click (standard tree behavior); files
  // open on DOUBLE click so a single click just selects/focuses the row,
  // matching VS Code / most file managers.
  const handleClick = async () => {
    if (renaming) return;
    if (isDir) {
      await onToggle(entry.relative);
    }
    // Files do nothing on single click (selection is implicit via the row).
  };

  const handleDoubleClick = async () => {
    if (renaming || isDir) return;
    if (!entry.name.endsWith(".typ")) return;
    if (rootPath === null) return;
    try {
      setLoading(true);
      const abs = `${rootPath}/${entry.relative}`;
      const existing = readOrderedDocuments().find((t) => t.path === abs);
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
    openMenu(buildRowMenu(entry, setRenaming, setPendingNew, deleteEntry), e.clientX, e.clientY);
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
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        title={entry.relative}
      >
        <span className={`tree-twisty${isDir && isOpen ? " tree-twisty-open" : ""}`}>
          {isDir && <ChevronRight size={12} />}
        </span>
        <span className="tree-icon">
          {isDir ? (
            isOpen ? <FolderOpen size={ICON_SIZE} /> : <Folder size={ICON_SIZE} />
          ) : (
            <File size={ICON_SIZE} />
          )}
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
          </>
        )}
      </div>
      {isDir && children !== undefined && (
        <div
          className={"tree-children" + (isOpen ? " open" : "")}
          inert={!isOpen || undefined}
        >
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
        </div>
      )}
    </li>
  );
}

/** Build the right-click menu items for a single file or directory row. */
function buildRowMenu(
  entry: DirEntry,
  setRenaming: (v: boolean) => void,
  setPendingNew: (v: { dir: string; kind: EntryKind } | null) => void,
  deleteEntry: (rel: string) => Promise<void>,
) {
  const isDir = entry.kind === "dir";
  const parentDir = entry.relative.includes("/")
    ? entry.relative.slice(0, entry.relative.lastIndexOf("/"))
    : "";
  const copyToClipboard = (text: string) => {
    navigator.clipboard?.writeText(text).catch((e) => {
      console.warn("[Explorer] clipboard write failed:", e);
    });
  };

  const items = [
    {
      type: "action" as const,
      label: "New File",
      icon: <FilePlus size={ICON_SIZE} />,
      onSelect: () => setPendingNew({ dir: isDir ? entry.relative : parentDir, kind: "file" as EntryKind }),
    },
    ...(isDir
      ? [
          {
            type: "action" as const,
            label: "New Folder",
            icon: <FolderPlus size={ICON_SIZE} />,
            onSelect: () =>
              setPendingNew({ dir: entry.relative, kind: "dir" as EntryKind }),
          },
        ]
      : []),
    {
      type: "action" as const,
      label: "Rename",
      icon: <Pencil size={ICON_SIZE} />,
      onSelect: () => setRenaming(true),
    },
    { type: "separator" as const },
    {
      type: "action" as const,
      label: "Copy Name",
      icon: <Copy size={ICON_SIZE} />,
      onSelect: () => copyToClipboard(entry.name),
    },
    {
      type: "action" as const,
      label: "Copy Relative Path",
      icon: <Copy size={ICON_SIZE} />,
      onSelect: () => copyToClipboard(entry.relative),
    },
    {
      type: "action" as const,
      label: "Reveal in Finder",
      icon: <SquareArrowOutUpRight size={ICON_SIZE} />,
      onSelect: () => void revealInFinder(entry.relative).catch((e) => {
        window.alert(`Reveal failed: ${e instanceof Error ? e.message : e}`);
      }),
    },
    { type: "separator" as const },
    {
      type: "action" as const,
      label: "Delete",
      icon: <Trash2 size={ICON_SIZE} />,
      danger: true,
      onSelect: () => void handleDeleteWithConfirm(entry, deleteEntry),
    },
  ];
  return items;
}

async function handleDeleteWithConfirm(
  entry: DirEntry,
  deleteEntry: (rel: string) => Promise<void>,
) {
  const ok = window.confirm(`Delete "${entry.name}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await deleteEntry(entry.relative);
  } catch (e) {
    window.alert(`Delete failed: ${e instanceof Error ? e.message : e}`);
  }
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
        <span className="tree-icon">
          {kind === "dir" ? <Folder size={ICON_SIZE} /> : <File size={ICON_SIZE} />}
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
