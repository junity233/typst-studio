import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  CopyPlus,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Scissors,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import type { DirEntry, EntryKind } from "../../lib/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore, readAllDocuments } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useFileClipboardStore, readClipboard } from "../../store/fileClipboardStore";
import { useExplorerSelectionStore } from "../../store/explorerSelectionStore";
import { openFileByPath, revealInFinder } from "../../lib/tauri";
import { toIpcError } from "../../lib/ipc-error";
import i18n from "../../i18n";
import { isMac } from "../../lib/platform";
import { useContextMenuStore, type MenuItem } from "./contextMenuStore";
import {
  allLoadedEntries,
  joinRel,
  parentRel,
  resolveCollision,
} from "./explorerOps";
import type { TFunction } from "i18next";
import {
  joinWorkspacePath,
  workspacePathsEqual,
} from "../../lib/workspacePath";

const ICON_SIZE = 14;

/**
 * The workspace file explorer: a lazy, recursively-expandable tree of the open
 * folder. Supports browse + open (double-click a `.typ`), file management via
 * the toolbar (New File / New Folder) and a feature-rich right-click context
 * menu (Rename / Delete / Copy / Cut / Paste / Duplicate / Reveal / Copy-Path).
 * Renames use an inline editor. Folders expand/collapse with a CSS grid height
 * transition.
 *
 * Keyboard shortcuts (F2 / Delete / Shift+Delete / Ctrl+C / Ctrl+X / Ctrl+V /
 * Ctrl+D) are bound on the tree container and only fire when it holds focus —
 * never stealing Monaco's clipboard chords.
 *
 * Drag-to-move is deferred — the context menu + shortcuts cover the daily cases.
 */

/** Copy text to the system clipboard, warning (not throwing) on failure. */
function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch((e) => {
    console.warn("[Explorer] clipboard write failed:", e);
  });
}

/** Run a destructive-delete (trash or permanent) with shared error handling. */
async function doDeleteWithConfirm(
  entry: DirEntry,
  deleteFn: (rel: string) => Promise<unknown>,
  confirm: string,
  errKey: string,
) {
  const ok = window.confirm(confirm);
  if (!ok) return;
  try {
    await deleteFn(entry.relative);
  } catch (e) {
    const err = toIpcError(e);
    if (err.code === "delete_blocked") {
      const affected = extractAffectedDocs(err.details);
      const names = affected.length > 0 ? affected.join("\n") : "";
      window.alert(
        names
          ? i18n.t("deleteBlockedWithNames", {
              ns: "errors",
              name: entry.name,
              count: affected.length,
              names,
            })
          : i18n.t("deleteBlocked", {
              ns: "errors",
              name: entry.name,
              count: affected.length,
            }),
      );
      return;
    }
    window.alert(i18n.t(errKey, { ns: "errors", message: err.message }));
  }
}

/** Trash an entry with a confirm prompt (the default delete path; recoverable). */
function handleDeleteWithConfirm(
  entry: DirEntry,
  deleteEntry: (rel: string) => Promise<unknown>,
) {
  const isDir = entry.kind === "dir";
  return doDeleteWithConfirm(
    entry,
    deleteEntry,
    i18n.t(isDir ? "deleteConfirmDir" : "deleteConfirmFile", { ns: "errors", name: entry.name }),
    "deleteFailed",
  );
}

/** Permanently delete an entry (NOT recoverable) with a stronger confirm. */
function handleDeletePermanentWithConfirm(
  entry: DirEntry,
  deleteEntryPermanent: (rel: string) => Promise<unknown>,
) {
  const isDir = entry.kind === "dir";
  return doDeleteWithConfirm(
    entry,
    deleteEntryPermanent,
    i18n.t(isDir ? "sidebar:explorer.deletePermanentlyConfirmDir" : "sidebar:explorer.deletePermanentlyConfirmFile", {
      name: entry.name,
    }),
    "deletePermanentlyFailed",
  );
}

/**
 * Pull the affected-doc paths out of a `delete_blocked` error's `details`
 * (§5.5). The backend carries `{ affectedDocs: [{ id, path }, ...] }`; we only
 * need the paths for the user-facing message.
 */
function extractAffectedDocs(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const affected = (details as { affectedDocs?: unknown }).affectedDocs;
  if (!Array.isArray(affected)) return [];
  return affected
    .map((d) => (typeof d === "object" && d !== null ? (d as { path?: unknown }).path : null))
    .filter((p): p is string => typeof p === "string");
}

/**
 * Paste the clipboard entry into `destDir`. Copy mode → duplicate (source kept);
 * cut mode → move (source removed). Name collisions resolve to "X copy". On a
 * cut-paste, the clipboard is cleared after the move. Surfaces errors via
 * `window.alert` with the right i18n key.
 */
async function handlePaste(destDir: string) {
  const { entries, mode } = readClipboard();
  if (entries.length === 0) return;
  const ws = useWorkspaceStore.getState();
  const tree = ws.tree;
  const existing = allLoadedEntries(tree);
  for (const entry of entries) {
    // Don't paste a dir into itself / a descendant of itself (would recurse).
    if (entry.kind === "dir" && (destDir === entry.relative || destDir.startsWith(entry.relative + "/"))) {
      window.alert(i18n.t("pasteFailed", { ns: "errors", message: entry.name }));
      continue;
    }
    const desiredRel = joinRel(destDir, entry.name);
    const target = resolveCollision(desiredRel, existing);
    try {
      if (mode === "copy") {
        await ws.copyEntry(entry.relative, target);
      } else {
        await ws.renameEntry(entry.relative, target);
      }
      existing.add(target);
    } catch (e) {
      const key = mode === "copy" ? "copyFailed" : "pasteFailed";
      window.alert(i18n.t(key, { ns: "errors", message: toIpcError(e).message }));
    }
  }
  // Cut moves the source — the clipboard is now stale (points at the old path).
  if (mode === "cut") {
    useFileClipboardStore.getState().clear();
  }
}

/** Duplicate an entry in its own directory (always renames — "X copy"). */
async function handleDuplicate(entry: DirEntry) {
  const ws = useWorkspaceStore.getState();
  const existing = allLoadedEntries(ws.tree);
  const parent = parentRel(entry.relative);
  const target = resolveCollision(joinRel(parent, entry.name), existing);
  try {
    await ws.copyEntry(entry.relative, target);
  } catch (e) {
    window.alert(i18n.t("duplicateFailed", { ns: "errors", message: toIpcError(e).message }));
  }
}

export function Explorer(_props: { viewId?: string }) {
  const { t } = useTranslation(["sidebar", "common"]);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const name = useWorkspaceStore((s) => s.name);
  const tree = useWorkspaceStore((s) => s.tree);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const createEntry = useWorkspaceStore((s) => s.createEntry);
  const collapseAll = useWorkspaceStore((s) => s.collapseAll);
  const expandAll = useWorkspaceStore((s) => s.expandAll);
  const deleteEntry = useWorkspaceStore((s) => s.deleteEntry);
  const deleteEntryPermanent = useWorkspaceStore((s) => s.deleteEntryPermanent);
  const openMenu = useContextMenuStore((s) => s.open);
  // Track the cut set so rows re-render with the `.tree-row-cut` style.
  const clipEntries = useFileClipboardStore((s) => s.entries);
  const clipMode = useFileClipboardStore((s) => s.mode);
  const setSelected = useExplorerSelectionStore((s) => s.set);
  const selectedRelForChildren = useExplorerSelectionStore((s) => s.selectedRel);
  const rootEntries = tree[""] ?? [];

  // The directory a "new file/folder" prompt is targeting (relative; "" = root).
  // When set, a TreeRow for that dir renders an inline name input.
  const [pendingNew, setPendingNew] = useState<{ dir: string; kind: EntryKind } | null>(null);
  // A pending rename initiated by keyboard (F2) — keyed by the entry's relative
  // path. TreeRow flips into its inline editor when its own relative matches.
  const [pendingRename, setPendingRename] = useState<string | null>(null);

  if (rootPath === null) return null;

  const handleNew = (kind: EntryKind) => {
    setPendingNew({ dir: "", kind });
  };

  /** Find a DirEntry anywhere in the loaded tree by its relative path. */
  const findEntryByRel = (rel: string): DirEntry | null => {
    for (const entries of Object.values(tree)) {
      const hit = entries.find((e) => e.relative === rel);
      if (hit) return hit;
    }
    return null;
  };

  const handleBodyContextMenu = (e: React.MouseEvent) => {
    // Right-click on empty space (not on a row — rows stopPropagation).
    e.preventDefault();
    const canPaste = useFileClipboardStore.getState().entries.length > 0;
    openMenu(
      [
        {
          type: "action",
          label: t("sidebar:explorer.newFile"),
          icon: <FilePlus size={ICON_SIZE} />,
          onSelect: () => handleNew("file"),
        },
        {
          type: "action",
          label: t("sidebar:explorer.newFolder"),
          icon: <FolderPlus size={ICON_SIZE} />,
          onSelect: () => handleNew("dir"),
        },
        ...(canPaste
          ? [
              { type: "separator" as const },
              {
                type: "action" as const,
                label: t("sidebar:explorer.paste"),
                icon: <ClipboardPaste size={ICON_SIZE} />,
                onSelect: () => void handlePaste(""),
              },
            ]
          : []),
        { type: "separator" },
        {
          type: "action",
          label: t("sidebar:explorer.collapseAll"),
          icon: <ChevronsDownUp size={ICON_SIZE} />,
          onSelect: () => void collapseAll(),
        },
        {
          type: "action",
          label: t("sidebar:explorer.expandAll"),
          icon: <ChevronsUpDown size={ICON_SIZE} />,
          onSelect: () => void expandAll(),
        },
      ],
      e.clientX,
      e.clientY,
    );
  };

  /** Build the right-click menu for a single row, then open it. */
  const openRowMenu = (entry: DirEntry, x: number, y: number) => {
    openMenu(
      buildRowMenu(entry, {
        rootPath,
        t,
        setPendingNew,
        setPendingRename: () => setPendingRename(entry.relative),
        deleteEntry,
        deleteEntryPermanent,
      }),
      x,
      y,
    );
  };

  /**
   * Tree-level keyboard shortcuts. Bound on the `.explorer-body` container (not
   * capture-phase), so they only fire when the tree itself holds focus — Monaco
   * keeps its own Ctrl+C / Ctrl+X / Ctrl+V. `INPUT` focus (inline rename) is
   * skipped so Enter/Esc/Delete don't fight the text field.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const ae = document.activeElement;
    if (ae instanceof HTMLInputElement) return;
    const selectedRel = useExplorerSelectionStore.getState().selectedRel;
    if (selectedRel === null) return;
    const entry = findEntryByRel(selectedRel);
    if (entry === null) return;
    const mod = e.metaKey || e.ctrlKey;
    // F2 → rename.
    if (e.key === "F2") {
      e.preventDefault();
      setPendingRename(entry.relative);
      return;
    }
    // Delete → trash; Shift+Delete → permanent.
    if (e.key === "Delete") {
      e.preventDefault();
      if (e.shiftKey) {
        void handleDeletePermanentWithConfirm(entry, deleteEntryPermanent);
      } else {
        void handleDeleteWithConfirm(entry, deleteEntry);
      }
      return;
    }
    // Ctrl/Cmd+C → copy; Ctrl/Cmd+X → cut; Ctrl/Cmd+V → paste into the row's dir;
    // Ctrl/Cmd+D → duplicate.
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        useFileClipboardStore.getState().setCopy(entry.relative, entry.name, entry.kind);
        return;
      }
      if (k === "x") {
        e.preventDefault();
        useFileClipboardStore.getState().setCut(entry.relative, entry.name, entry.kind);
        return;
      }
      if (k === "v") {
        e.preventDefault();
        const destDir = entry.kind === "dir" ? entry.relative : parentRel(entry.relative);
        void handlePaste(destDir);
        return;
      }
      if (k === "d") {
        e.preventDefault();
        void handleDuplicate(entry);
        return;
      }
    }
  };

  const cutRels = useMemo(
    () =>
      clipMode === "cut" ? new Set(clipEntries.map((e) => e.relative)) : new Set<string>(),
    [clipMode, clipEntries],
  );

  return (
    <div className="explorer">
      <div className="explorer-header" title={rootPath}>
        <span className="explorer-title">{name ?? t("sidebar:explorer.workspace")}</span>
        <span className="explorer-actions">
          <button
            className="explorer-action"
            title={t("sidebar:explorer.newFile")}
            onClick={() => handleNew("file")}
          >
            <FilePlus size={14} />
          </button>
          <button
            className="explorer-action"
            title={t("sidebar:explorer.newFolder")}
            onClick={() => handleNew("dir")}
          >
            <FolderPlus size={14} />
          </button>
        </span>
      </div>
      <div
        className="explorer-body"
        tabIndex={0}
        onContextMenu={handleBodyContextMenu}
        onKeyDown={handleKeyDown}
      >
        {rootEntries.length === 0 && pendingNew === null ? (
          <p className="explorer-empty">{t("sidebar:explorer.folderEmpty")}</p>
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
                cutRels={cutRels}
                selectedRel={selectedRelForChildren}
                onSelect={setSelected}
                pendingRename={pendingRename}
                clearPendingRename={() => setPendingRename(null)}
                openRowMenu={openRowMenu}
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
  /** Relative paths currently in the cut clipboard (rendered de-emphasized). */
  cutRels: Set<string>;
  /** Currently-selected row path (keyboard anchor). */
  selectedRel: string | null;
  /** Set the keyboard-selection anchor (on click / right-click). */
  onSelect: (rel: string | null) => void;
  /** A relative path that should enter inline-rename now (F2 / menu Rename). */
  pendingRename: string | null;
  /** Clear the pending-rename request once consumed. */
  clearPendingRename: () => void;
  /** Open the row context menu at (x, y). Injected so the parent owns buildRowMenu deps. */
  openRowMenu: (entry: DirEntry, x: number, y: number) => void;
}

function TreeRow({
  entry,
  depth,
  tree,
  expanded,
  onToggle,
  pendingNew,
  setPendingNew,
  cutRels,
  selectedRel,
  onSelect,
  pendingRename,
  clearPendingRename,
  openRowMenu,
}: TreeRowProps) {
  const openPath = useTabsStore((s) => s.openPath);
  const activeId = useTabsStore((s) => s.activeId);
  // Subscribe to the documents map so the active-file highlight tracks path
  // changes (e.g. after Save As) and dirty/open state.
  const documents = useDocumentsStore((s) => s.documents);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const renameEntry = useWorkspaceStore((s) => s.renameEntry);
  const createEntry = useWorkspaceStore((s) => s.createEntry);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);

  // A rename requested via keyboard (F2) or the parent menu arrives via
  // `pendingRename`; consume it by flipping into the inline editor once.
  useEffect(() => {
    if (pendingRename === entry.relative && !renaming) {
      setRenaming(true);
      clearPendingRename();
    }
  }, [pendingRename, entry.relative, renaming, clearPendingRename]);

  const isDir = entry.kind === "dir";
  const isOpen = expanded.has(entry.relative);
  const isCut = cutRels.has(entry.relative);
  const isSelected = selectedRel === entry.relative;
  // `children` is undefined until the dir has been loaded at least once.
  // We keep the animated container mounted whenever children are loaded, so
  // the open/close transition has real content to animate over.
  const children = isDir ? tree[entry.relative] : undefined;

  const isActiveFile =
    !isDir &&
    rootPath !== null &&
    activeId !== null &&
    workspacePathsEqual(
      documents[activeId]?.path ?? null,
      joinWorkspacePath(rootPath, entry.relative),
    );

  // Folders expand/collapse on single click (standard tree behavior); files
  // open on DOUBLE click so a single click just selects/focuses the row,
  // matching VS Code / most file managers.
  const handleClick = async () => {
    if (renaming) return;
    onSelect(entry.relative);
    if (isDir) {
      await onToggle(entry.relative);
    }
    // Files do nothing on single click (selection is tracked via onSelect).
  };

  const handleDoubleClick = async () => {
    if (renaming || isDir) return;
    if (!entry.name.endsWith(".typ")) return;
    if (rootPath === null) return;
    try {
      setLoading(true);
      const abs = joinWorkspacePath(rootPath, entry.relative);
      const existing = readAllDocuments().find((t) =>
        workspacePathsEqual(t.path, abs),
      );
      if (existing) {
        // Phase B2: a soft-closed file re-activates instead of opening a dup.
        if (existing.hidden) {
          await useTabsStore.getState().reactivate(existing.id);
        } else {
          useTabsStore.getState().activate(existing.id);
        }
        return;
      }
      const doc = await openFileByPath(abs);
      openPath(doc);
    } catch (e) {
      console.error("[Explorer] open failed:", e, {
        rootPath,
        relative: entry.relative,
        abs: `${rootPath}/${entry.relative}`,
      });
      window.alert(
        i18n.t("couldNotOpenFile", {
          ns: "errors",
          name: entry.name,
          message: toIpcError(e).message,
        }),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(entry.relative);
    openRowMenu(entry, e.clientX, e.clientY);
  };

  const commitRename = async (newName: string) => {
    setRenaming(false);
    const trimmed = newName.trim();
    if (trimmed === "" || trimmed === entry.name) return;
    const parent = parentRel(entry.relative);
    const to = joinRel(parent, trimmed);
    try {
      await renameEntry(entry.relative, to);
    } catch (e) {
      window.alert(
        i18n.t("renameFailed", {
          ns: "errors",
          message: toIpcError(e).message,
        }),
      );
    }
  };

  const rowClass =
    "tree-row" +
    (isActiveFile ? " tree-row-active" : "") +
    (isSelected ? " tree-row-selected" : "") +
    (isCut ? " tree-row-cut" : "");

  return (
    <li role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <div
        className={rowClass}
        style={{ "--tree-depth": depth } as React.CSSProperties}
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
                cutRels={cutRels}
                selectedRel={selectedRel}
                onSelect={onSelect}
                pendingRename={pendingRename}
                clearPendingRename={clearPendingRename}
                openRowMenu={openRowMenu}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * Build the right-click menu items for a single file or directory row. The
 * resulting structure (group order: New → Rename → clipboard → copy-path →
 * reveal → delete) mirrors VS Code's Explorer menu so the muscle memory
 * transfers. Destructive items (`Delete Permanently`) are `danger`-flagged;
 * `Paste` is disabled when the clipboard is empty.
 */
function buildRowMenu(
  entry: DirEntry,
  deps: {
    rootPath: string | null;
    t: TFunction;
    setPendingNew: (v: { dir: string; kind: EntryKind } | null) => void;
    setPendingRename: () => void;
    deleteEntry: (rel: string) => Promise<unknown>;
    deleteEntryPermanent: (rel: string) => Promise<unknown>;
  },
): MenuItem[] {
  const { rootPath, t, setPendingNew, setPendingRename, deleteEntry, deleteEntryPermanent } = deps;
  const isDir = entry.kind === "dir";
  const parentDir = parentRel(entry.relative);
  const clip = readClipboard();
  const canPaste = clip.entries.length > 0;
  // A paste target must be a directory; a file's paste target is its parent.
  const pasteTarget = isDir ? entry.relative : parentDir;
  // Refuse to paste a dir into itself or a descendant of itself.
  const pasteBlocked =
    canPaste &&
    clip.entries.some(
      (c) =>
        c.kind === "dir" &&
        (pasteTarget === c.relative || pasteTarget.startsWith(c.relative + "/")),
    );

  const copyPathSubmenu: MenuItem = {
    type: "submenu",
    label: t("sidebar:explorer.copyPath"),
    children: [
      {
        type: "action",
        label: t("sidebar:explorer.copyName"),
        icon: <Copy size={ICON_SIZE} />,
        onSelect: () => copyToClipboard(entry.name),
      },
      {
        type: "action",
        label: t("sidebar:explorer.copyRelativePath"),
        icon: <Copy size={ICON_SIZE} />,
        onSelect: () => copyToClipboard(entry.relative),
      },
      ...(rootPath !== null
        ? [
            {
              type: "action" as const,
              label: t("sidebar:explorer.copyAbsolutePath"),
              icon: <Copy size={ICON_SIZE} />,
              onSelect: () => copyToClipboard(joinWorkspacePath(rootPath, entry.relative)),
            },
          ]
        : []),
    ],
  };

  const items: MenuItem[] = [
    {
      type: "action",
      label: t("sidebar:explorer.newFile"),
      icon: <FilePlus size={ICON_SIZE} />,
      onSelect: () =>
        setPendingNew({ dir: isDir ? entry.relative : parentDir, kind: "file" }),
    },
    ...(isDir
      ? [
          {
            type: "action" as const,
            label: t("sidebar:explorer.newFolder"),
            icon: <FolderPlus size={ICON_SIZE} />,
            onSelect: () => setPendingNew({ dir: entry.relative, kind: "dir" }),
          },
        ]
      : []),
    {
      type: "action",
      label: t("sidebar:explorer.rename"),
      icon: <Pencil size={ICON_SIZE} />,
      onSelect: setPendingRename,
    },
    { type: "separator" },
    {
      type: "action",
      label: t("sidebar:explorer.cut"),
      icon: <Scissors size={ICON_SIZE} />,
      onSelect: () =>
        useFileClipboardStore.getState().setCut(entry.relative, entry.name, entry.kind),
    },
    {
      type: "action",
      label: t("sidebar:explorer.copy"),
      icon: <Copy size={ICON_SIZE} />,
      onSelect: () =>
        useFileClipboardStore.getState().setCopy(entry.relative, entry.name, entry.kind),
    },
    {
      type: "action",
      label: t("sidebar:explorer.paste"),
      icon: <ClipboardPaste size={ICON_SIZE} />,
      disabled: !canPaste || pasteBlocked,
      onSelect: () => void handlePaste(pasteTarget),
    },
    {
      type: "action",
      label: t("sidebar:explorer.duplicate"),
      icon: <CopyPlus size={ICON_SIZE} />,
      onSelect: () => void handleDuplicate(entry),
    },
    { type: "separator" },
    copyPathSubmenu,
    {
      type: "action",
      label: isMac
        ? t("sidebar:explorer.revealInFinder")
        : t("sidebar:explorer.revealInFileExplorer"),
      icon: <SquareArrowOutUpRight size={ICON_SIZE} />,
      onSelect: () =>
        void revealInFinder(entry.relative).catch((e) => {
          window.alert(
            i18n.t("revealFailed", { ns: "errors", message: toIpcError(e).message }),
          );
        }),
    },
    { type: "separator" },
    {
      type: "action",
      label: t("common:delete"),
      icon: <Trash2 size={ICON_SIZE} />,
      onSelect: () => void handleDeleteWithConfirm(entry, deleteEntry),
    },
    {
      type: "action",
      label: t("sidebar:explorer.deletePermanently"),
      icon: <Trash2 size={ICON_SIZE} />,
      danger: true,
      onSelect: () => void handleDeletePermanentWithConfirm(entry, deleteEntryPermanent),
    },
  ];
  return items;
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
  const { t } = useTranslation("sidebar");
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
      placeholder={t("explorer.namePlaceholder")}
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
      <div className="tree-row" style={{ "--tree-depth": depth } as React.CSSProperties}>
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
