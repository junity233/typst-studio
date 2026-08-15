import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  sideBySideDiff,
  hasChanges,
  type DiffRow,
  type TokenSpan,
} from "../../lib/diff";

/**
 * Shared side-by-side diff compare used by the conflict-resolution (§5.4) and
 * crash-recovery (§5.1.3) dialogs — the two places where the user must decide
 * which version of their work to keep.
 *
 * Rows are aligned in a single CSS grid (one row = left cell + right cell), so
 * deleted / added / word-changed lines always line up horizontally. Long
 * unchanged runs collapse to a "⋯ N unchanged lines ⋯" gap row; paired changed
 * lines highlight the differing words on each side.
 *
 * The diff runs synchronously on open, but `sideBySideDiff` is
 * allocation-bounded (LCS cell caps with a coarse fallback), so a huge
 * document can never hang the dialog.
 */
export interface DiffCompareViewProps {
  ariaLabel: string;
  /** Column header for the left pane (e.g. "Editor buffer"). */
  leftLabel: string;
  /** Column header for the right pane (e.g. "Disk"). */
  rightLabel: string;
  leftText: string;
  /**
   * Right-side text, or `null` when there is nothing to compare against (the
   * recovery case of a snapshot whose file is gone). `null` renders the left
   * pane unhighlighted plus a centered `rightMissingLabel` note.
   */
  rightText: string | null;
  /** Shown instead of the right pane's content when `rightText` is null. */
  rightMissingLabel?: string;
}

/** Normalize CRLF/CR to LF — the buffer is LF-normalized, disk may not be. */
function normalizeEol(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function DiffCompareView({
  ariaLabel,
  leftLabel,
  rightLabel,
  leftText,
  rightText,
  rightMissingLabel,
}: DiffCompareViewProps) {
  const { t } = useTranslation("dialog");
  const rows = useMemo(
    () =>
      rightText === null
        ? // Nothing to compare against: show the left lines as plain context.
          normalizeEol(leftText)
            .split("\n")
            .map((text): DiffRow => ({ kind: "equal", text }))
        : sideBySideDiff(normalizeEol(leftText), normalizeEol(rightText)),
    [leftText, rightText],
  );

  return (
    <div className="diffcmp">
      <div className="diffcmp-head">
        <div className="diffcmp-label">{leftLabel}</div>
        <div className="diffcmp-label">{rightLabel}</div>
      </div>
      <div className="diffcmp-body" role="region" aria-label={ariaLabel}>
        {rightText === null && (
          <div className="diffcmp-note">{rightMissingLabel}</div>
        )}
        {rightText !== null && !hasChanges(rows) && (
          <div className="diffcmp-note">{t("diffView.noDifferences")}</div>
        )}
        {rows.map((row, i) => (
          <DiffRowView key={i} row={row} />
        ))}
      </div>
    </div>
  );
}

/** Render one diff row as a `display: contents` wrapper around two cells. */
function DiffRowView({ row }: { row: DiffRow }) {
  const { t } = useTranslation("dialog");
  switch (row.kind) {
    case "gap":
      return (
        <div className="diffcmp-row">
          <div className="diffcmp-gap" role="presentation">
            {t("diffView.unchangedLines", { count: row.count })}
          </div>
        </div>
      );
    case "equal":
      return (
        <div className="diffcmp-row">
          <div className="diffcmp-cell diffcmp-cell--left">{row.text}</div>
          <div className="diffcmp-cell">{row.text}</div>
        </div>
      );
    case "del":
      return (
        <div className="diffcmp-row">
          <div className="diffcmp-cell diffcmp-cell--left diffcmp-cell--del">
            {row.text}
          </div>
          <div className="diffcmp-cell" />
        </div>
      );
    case "add":
      return (
        <div className="diffcmp-row">
          <div className="diffcmp-cell diffcmp-cell--left" />
          <div className="diffcmp-cell diffcmp-cell--add">{row.text}</div>
        </div>
      );
    case "pair":
      return (
        <div className="diffcmp-row">
          <div className="diffcmp-cell diffcmp-cell--left diffcmp-cell--del">
            <Spans spans={row.left} />
          </div>
          <div className="diffcmp-cell diffcmp-cell--add">
            <Spans spans={row.right} />
          </div>
        </div>
      );
  }
}

/** Emphasized word segments inside a paired changed line. */
function Spans({ spans }: { spans: readonly TokenSpan[] }) {
  if (spans.length === 0) return null;
  return (
    <>
      {spans.map((s, i) =>
        s.emphasis === "same" ? (
          <span key={i}>{s.text}</span>
        ) : (
          <span key={i} className={`diffcmp-em diffcmp-em--${s.emphasis}`}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}
