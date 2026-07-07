import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { BibEntryEditable } from "../../../lib/types";

/** The common BibLaTeX/Hayagriva entry types offered in the Type dropdown. */
const ENTRY_TYPES = [
  "article",
  "book",
  "booklet",
  "inbook",
  "incollection",
  "inproceedings",
  "manual",
  "misc",
  "online",
  "proceedings",
  "report",
  "thesis",
  "unpublished",
  "patent",
  "software",
] as const;

/** Small icon for the delete-extra-row button + add-field button. */
const ROW_ICON = 14;

export interface BibEditModalProps {
  /** "add" → blank template, "edit" → pre-fill from the selected entry. */
  mode: "add" | "edit";
  /** For "edit", the current entry; for "add", a blank template. */
  initial: BibEntryEditable;
  /** Called with the assembled entry when the user confirms. */
  onConfirm: (entry: BibEntryEditable) => void;
  /** Called on Esc, overlay-click, or the cancel button. */
  onCancel: () => void;
}

/**
 * The bibliography add/edit modal. Mirrors `LinkModal`'s structure: a
 * portal-rendered `.dialog-overlay` + `.dialog`, autofocus, Escape/overlay-click
 * = cancel, Enter submits. Owns only its own field state; `onConfirm` reports
 * the assembled `BibEntryEditable` and the parent unmounts it.
 *
 * Fields: citation key (required), type (select), title, authors (textarea, one
 * per line), year (number), and a dynamic `extra` field list. The extra list is
 * generic `[name, value]` pairs so any field (journal, volume, pages, url, …)
 * can be edited without a fixed schema.
 *
 * Styling reuses `.dialog` / `.dialog-title` / `.dialog-actions` / `.btn-*` and
 * adds a `.bib-edit-modal` modifier (wider, like `.link-modal`) plus
 * `.bib-edit-field` / `.bib-edit-extra-row` / `.bib-edit-add-field` for the
 * form layout. All `var(--…)` tokens, no hardcoded colors.
 */
export function BibEditModal({ mode, initial, onConfirm, onCancel }: BibEditModalProps) {
  const { t } = useTranslation("bibliography");
  // Individual useState per field, mirroring LinkModal's pattern.
  const [key, setKey] = useState(initial.key);
  const [entryType, setEntryType] = useState(initial.entryType || "misc");
  const [title, setTitle] = useState(initial.title ?? "");
  const [authors, setAuthors] = useState(initial.authors.join("\n"));
  const [year, setYear] = useState(initial.year != null ? String(initial.year) : "");
  const [extra, setExtra] = useState<Array<[string, string]>>(
    initial.extra.map(([n, v]) => [n, v]),
  );

  const keyRef = useRef<HTMLInputElement>(null);
  // Autofocus the citation key on mount (one-shot — the modal mounts fresh).
  useEffect(() => {
    keyRef.current?.focus();
  }, []);

  const keyValid = key.trim().length > 0;

  const submit = () => {
    if (!keyValid) return; // key required — empty is a no-op (don't close)
    const assembled: BibEntryEditable = {
      key: key.trim(),
      entryType,
      title: title.trim() === "" ? null : title.trim(),
      authors: authors
        .split("\n")
        .map((a) => a.trim())
        .filter((a) => a !== ""),
      year: year.trim() === "" ? null : Number(year),
      // Drop fully-empty extra rows; keep the rest as-is (trimmed).
      extra: extra
        .map(([n, v]) => [n.trim(), v.trim()] as [string, string])
        .filter(([n, v]) => n !== "" || v !== ""),
    };
    onConfirm(assembled);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  };

  const titleKey = mode === "add" ? "addEntry" : "editEntry";

  return createPortal(
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={onCancel}
      onKeyDown={onKeyDown}
    >
      <div
        className="dialog bib-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t(titleKey)}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{t(titleKey)}</h2>
        <form
          className="bib-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="bib-edit-row">
            <label className="bib-edit-field bib-edit-field-key">
              <span className="bib-edit-label">{t("citationKey")}</span>
              <input
                ref={keyRef}
                className="bib-edit-input"
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="einstein1905"
              />
            </label>
            <label className="bib-edit-field bib-edit-field-type">
              <span className="bib-edit-label">{t("type")}</span>
              <select
                className="bib-edit-input bib-edit-select"
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
              >
                {ENTRY_TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {tp}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="bib-edit-field">
            <span className="bib-edit-label">{t("fieldTitle")}</span>
            <input
              className="bib-edit-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="bib-edit-field">
            <span className="bib-edit-label">{t("authors")}</span>
            <textarea
              className="bib-edit-input bib-edit-textarea"
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
              rows={3}
              placeholder={t("authorsPlaceholder", { defaultValue: "One author per line" })}
            />
          </label>

          <label className="bib-edit-field bib-edit-field-year">
            <span className="bib-edit-label">{t("year")}</span>
            <input
              className="bib-edit-input"
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="1905"
            />
          </label>

          <div className="bib-edit-extra">
            <span className="bib-edit-label">{t("extraFields")}</span>
            {extra.map((row, i) => (
              <div key={i} className="bib-edit-extra-row">
                <input
                  className="bib-edit-input bib-edit-extra-name"
                  type="text"
                  value={row[0]}
                  onChange={(e) => {
                    const next = [...extra];
                    next[i] = [e.target.value, row[1]];
                    setExtra(next);
                  }}
                  placeholder={t("fieldName")}
                  aria-label={t("fieldName")}
                />
                <input
                  className="bib-edit-input bib-edit-extra-value"
                  type="text"
                  value={row[1]}
                  onChange={(e) => {
                    const next = [...extra];
                    next[i] = [row[0], e.target.value];
                    setExtra(next);
                  }}
                  placeholder={t("fieldValue")}
                  aria-label={t("fieldValue")}
                />
                <button
                  type="button"
                  className="bib-edit-extra-remove"
                  onClick={() => setExtra(extra.filter((_, j) => j !== i))}
                  aria-label={t("delete")}
                >
                  <Trash2 size={ROW_ICON} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="bib-edit-add-field"
              onClick={() => setExtra([...extra, ["", ""]])}
            >
              <Plus size={ROW_ICON} />
              {t("addField")}
            </button>
          </div>

          {!keyValid && (
            <p className="bib-edit-hint">{t("keyRequired")}</p>
          )}

          <div className="dialog-actions">
            <button type="button" className="btn-utility" onClick={onCancel}>
              {t("cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={!keyValid}>
              {t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
