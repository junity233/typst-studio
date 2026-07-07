import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDebounce } from "../../../hooks/useDebounce";
import { useSymbolsStore } from "../../../store/symbolsStore";
import type { SymbolEntry } from "../../../store/symbolsStore";
import { editorApiRef } from "../../Editor/editorApiRef";
import { detectMathContext } from "./detectMathContext";

/**
 * Build the text to insert for `sym`, deciding markup-vs-math by inspecting the
 * live editor at the current caret. In math mode (`$...$`) the bare name is
 * inserted (`alpha`); in markup the symbol is qualified with the `sym` module
 * (`#sym.alpha`). Returns `null` when no editor/position is available so the
 * caller can no-op instead of inserting.
 *
 * Kept module-local (not in the store) because it reads the live editor through
 * the module-level `editorApiRef`, which has no business living in a pure store.
 */
function buildInsertText(sym: SymbolEntry): string | null {
  const api = editorApiRef.current;
  if (!api) return null;
  const pos = api.getCursorPosition();
  const lines = api.getModelLines();
  if (!pos || !lines) return null;
  const ctx = detectMathContext(lines, pos.lineNumber, pos.column);
  return ctx === "math" ? sym.name : `#sym.${sym.name}`;
}

/**
 * The Symbols sidebar view: browse Typst `sym` symbols by category, search by
 * name/glyph/keyword, and click to insert at the caret. Insertion is
 * context-aware (math vs. markup). Mirrors the Packages panel's shell.
 */
export function SymbolsPanel() {
  const { t } = useTranslation("symbols");
  const categories = useSymbolsStore((s) => s.categories);
  const activeCategoryId = useSymbolsStore((s) => s.activeCategoryId);
  const setActiveCategory = useSymbolsStore((s) => s.setActiveCategory);
  const query = useSymbolsStore((s) => s.query);
  const setQuery = useSymbolsStore((s) => s.setQuery);

  // Local input state, debounced into the store query so typing stays snappy.
  const [input, setInput] = useState(query);
  const debouncedInput = useDebounce(input, 150);
  useEffect(() => {
    setQuery(debouncedInput);
  }, [debouncedInput, setQuery]);

  const handleInsert = useCallback((sym: SymbolEntry) => {
    const text = buildInsertText(sym);
    if (text === null) return;
    editorApiRef.current?.replaceSelection(text);
  }, []);

  // Filter: active category (if any) AND case-insensitive query over the
  // symbol's name, glyph, and keywords.
  const normalizedQuery = debouncedInput.trim().toLowerCase();
  const visibleCategories = useMemo(
    () =>
      activeCategoryId === null
        ? categories
        : categories.filter((c) => c.id === activeCategoryId),
    [categories, activeCategoryId],
  );
  const symbols = useMemo(() => {
    if (normalizedQuery === "") {
      return visibleCategories.flatMap((c) => c.symbols);
    }
    return visibleCategories.flatMap((c) =>
      c.symbols.filter((s) => matchesQuery(s, normalizedQuery)),
    );
  }, [visibleCategories, normalizedQuery]);

  const isEmpty = symbols.length === 0;

  return (
    <div className="symbols-panel">
      <div className="symbols-search">
        <input
          className="symbols-search-input"
          type="search"
          placeholder={t("searchPlaceholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label={t("searchPlaceholder")}
        />
      </div>
      <div
        className="symbols-categories"
        role="tablist"
        aria-label={t("allCategories")}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeCategoryId === null}
          className={`symbols-chip${activeCategoryId === null ? " active" : ""}`}
          onClick={() => setActiveCategory(null)}
        >
          {t("allCategories")}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={activeCategoryId === c.id}
            className={`symbols-chip${activeCategoryId === c.id ? " active" : ""}`}
            onClick={() => setActiveCategory(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="symbols-body">
        {isEmpty ? (
          <p className="symbols-empty">{t("emptyState")}</p>
        ) : (
          <div className="symbols-grid" role="list">
            {symbols.map((sym) => {
              const preview = `#sym.${sym.name}`;
              return (
                <button
                  key={sym.name}
                  type="button"
                  className="symbol-button"
                  title={`${sym.name} · ${preview}`}
                  onClick={() => handleInsert(sym)}
                >
                  <span className="symbol-glyph" aria-hidden="true">
                    {sym.glyph}
                  </span>
                  <span className="symbol-name">{sym.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Case-insensitive match over a symbol's name, glyph, and keywords. */
function matchesQuery(sym: SymbolEntry, q: string): boolean {
  if (sym.name.toLowerCase().includes(q)) return true;
  if (sym.glyph.toLowerCase().includes(q)) return true;
  if (sym.keywords) {
    for (const kw of sym.keywords) {
      if (kw.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}
