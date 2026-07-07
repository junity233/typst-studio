import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Pencil, Quote, Trash2 } from "lucide-react";
import type { BibEntry } from "../../../lib/types";
import { useContextMenuStore, type MenuItem } from "../contextMenuStore";

/** Icon size matching the Explorer context menu (visual consistency). */
const ICON_SIZE = 14;

interface BibEntryItemProps {
  entry: BibEntry;
  /** Insert `#cite(<key>)` at the caret (context-menu "Insert Citation"). */
  onCite: (key: string) => void;
  /** Open the edit modal for this entry's key (double-click / Edit menu item). */
  onEdit: (key: string) => void;
  /** Delete the entry with this key (Delete menu item, after confirm). */
  onDelete: (key: string) => void;
}

/**
 * A single reference row: citation key (mono, prominent) + title + authors +
 * year. The row is a `<button>` (keyboard-focusable, a11y) but single-click is
 * a no-op — citation, editing, and deletion are all reached via the context
 * menu (right-click) and editing also via double-click. This replaces the
 * earlier click-to-cite behavior, which was too easy to trigger accidentally
 * when the user just wanted to select a row.
 *
 * Memoized because the list can be long and the row output depends only on its
 * `entry` + callback identities (the panel memoizes the handlers with
 * `useCallback` so they're stable across renders).
 */
function BibEntryItemImpl({ entry, onCite, onEdit, onDelete }: BibEntryItemProps) {
  const { t } = useTranslation("bibliography");
  const secondary = [entry.authors.join(", "), entry.year]
    .filter((s) => s !== undefined && s !== null && s !== "")
    .join(" · ");

  // Build the context menu at the click position. The items resolve `entry`
  // from the closure (the row's own entry), so they never go stale. Edit and
  // delete take the KEY (the panel looks up the full `BibEntryEditable` from
  // the store's `fullEntries` when building the modal/confirm).
  const openEntryMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const items: MenuItem[] = [
        {
          type: "action",
          label: t("insertCite"),
          icon: <Quote size={ICON_SIZE} />,
          onSelect: () => onCite(entry.key),
        },
        {
          type: "action",
          label: t("copyKey"),
          icon: <Copy size={ICON_SIZE} />,
          onSelect: () => {
            void navigator.clipboard.writeText(entry.key);
          },
        },
        { type: "separator" },
        {
          type: "action",
          label: t("edit"),
          icon: <Pencil size={ICON_SIZE} />,
          onSelect: () => onEdit(entry.key),
        },
        {
          type: "action",
          label: t("delete"),
          icon: <Trash2 size={ICON_SIZE} />,
          danger: true,
          onSelect: () => onDelete(entry.key),
        },
      ];
      useContextMenuStore.getState().open(items, e.clientX, e.clientY);
    },
    [entry.key, onCite, onEdit, onDelete, t],
  );

  const handleDoubleClick = useCallback(() => {
    onEdit(entry.key);
  }, [entry.key, onEdit]);

  return (
    <li className="bibliography-item" role="listitem">
      <button
        type="button"
        className="bibliography-item-button"
        // Single-click is now a no-op (kept as a button for focus/a11y). The
        // cite action moved to the context menu; edit opens on double-click.
        onClick={() => {
          /* no-op: cite is via context menu, edit via double-click */
        }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={openEntryMenu}
        title={entry.title ?? entry.key}
        aria-label={t("citeAria", { key: entry.key, defaultValue: `Cite {{key}}` })}
      >
        <span className="bibliography-item-key">{entry.key}</span>
        {entry.title && (
          <span className="bibliography-item-title">{entry.title}</span>
        )}
        {secondary && (
          <span className="bibliography-item-meta">{secondary}</span>
        )}
      </button>
    </li>
  );
}

export const BibEntryItem = memo(BibEntryItemImpl);
