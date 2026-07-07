import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { BibEntry } from "../../../lib/types";

interface BibEntryItemProps {
  entry: BibEntry;
  /** Insert `#cite(<key>)` at the caret. */
  onCite: (key: string) => void;
}

/**
 * A single reference row: citation key (mono, prominent) + title + authors +
 * year. Click anywhere on the row to insert `#cite(<key>)` at the caret.
 *
 * The whole row is a `<button>` so it is keyboard-focusable and announces as a
 * single actionable control. Memoized because the list can be long and the row
 * output depends only on its `entry` + `onCite` identity.
 */
function BibEntryItemImpl({ entry, onCite }: BibEntryItemProps) {
  const { t } = useTranslation("bibliography");
  const cite = `#cite(<${entry.key}>)`;
  const secondary = [entry.authors.join(", "), entry.year]
    .filter((s) => s !== undefined && s !== null && s !== "")
    .join(" · ");

  return (
    <li className="bibliography-item" role="listitem">
      <button
        type="button"
        className="bibliography-item-button"
        title={`${cite} — ${entry.title ?? ""}`}
        aria-label={t("citeAria", { key: entry.key, defaultValue: `Cite {{key}}` })}
        onClick={() => onCite(entry.key)}
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
