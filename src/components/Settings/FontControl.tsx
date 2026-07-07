import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingDef } from "../../lib/settings-types";
import { useSetting } from "../../hooks/useSetting";
import { listFonts } from "../../lib/tauri";
import { SETTING_ID } from "./SettingsApp";

/**
 * The font list is stable for the process lifetime (it reflects the warmed
 * `FontStore` — embedded + system scan + configured extra dirs — and changing
 * those needs an app restart). Cache the promise across all `FontControl`
 * instances so opening a second settings tab or re-rendering never re-fetches.
 */
let fontListPromise: Promise<string[]> | null = null;

function loadFontList(): Promise<string[]> {
  if (!fontListPromise) {
    fontListPromise = listFonts().catch((e) => {
      // On failure, drop the cached rejection so a later open can retry, and
      // surface an empty list (the control shows its "failed" state).
      fontListPromise = null;
      console.warn("[settings] list_fonts failed:", e);
      return [];
    });
  }
  return fontListPromise;
}

/**
 * A searchable font-family combobox for `font`-type settings. Stores the family
 * name as a plain string (matching `editor.fontFamily`'s contract); an empty
 * string means "use the built-in default stack".
 *
 * Each option renders in its own typeface for live preview. The value set is
 * not whitelisted — a name typed/selected that isn't installed is stored
 * verbatim; the editor falls back at render time.
 *
 * Interaction model (kept simple to avoid value-clobbering races):
 * - The input is a controlled view of the *committed* value when closed, and a
 *   throwaway search box when open. `query` never flows back into the store.
 * - A value is committed ONLY by an explicit selection (clicking an option,
 *   pressing Enter on a highlighted option, or the clear-X). Typing in the box
 *   filters the list but does not write — so a half-typed query that gets
 *   abandoned (blur / Esc) can never wipe the saved font.
 * - Closing (blur / Esc / outside-click) always restores the input to the
 *   committed value, dropping any in-flight query.
 */
export function FontControl({ def }: { def: SettingDef }) {
  const { t } = useTranslation("settings");
  const [value, setValue] = useSetting<string>(def.key);
  const fallback = typeof def.default === "string" ? def.default : "";
  const current = typeof value === "string" ? value : fallback;

  const [fonts, setFonts] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fetch the font list once on mount (the cached promise is shared).
  useEffect(() => {
    let cancelled = false;
    void loadFontList().then((list) => {
      if (!cancelled) setFonts(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (fonts === null) return [];
    const q = query.trim().toLowerCase();
    if (q === "") return fonts;
    return fonts.filter((f) => f.toLowerCase().includes(q));
  }, [fonts, query]);

  // Keep the highlighted index sensible as the filter changes:
  // - No query → rest on "(Default)" (index 0); Enter commits the empty value,
  //   which is the natural "clear back to default" gesture.
  // - A query is typed → jump to the first matching font (index 1) so Enter
  //   selects the visible match instead of wiping the value via "(Default)".
  // Indices: 0 = "(Default)", 1..filtered.length = real fonts.
  useEffect(() => {
    if (!open) return;
    setHighlight(query.trim() === "" || filtered.length === 0 ? 0 : 1);
  }, [open, query, filtered.length]);

  /** Commit a selection and collapse back to the closed (display) state. */
  const choose = (name: string) => {
    setValue(name);
    setOpen(false);
    setQuery("");
  };

  /**
   * Collapse without committing — drops the in-flight query and restores the
   * committed value to the display. Deferred a tick so a simultaneous option
   * click (whose `mousedown` runs just before this blur) can commit first:
   * `choose` flips `open` to false, and by the time this runs the guard below
   * is already a no-op. Without the deferral, blur fires first on some
   * platforms and races the selection.
   */
  const scheduleClose = () => {
    setTimeout(() => {
      setOpen(false);
      setQuery("");
    }, 0);
  };

  // The list has a synthetic "(Default)" row at index 0; real fonts occupy
  // highlight indices 1..filtered.length. So the max is filtered.length (the
  // last font), and Enter maps highlight 0 → "" and N → filtered[N-1].
  const maxHighlight = filtered.length; // (Default)=0, fonts=1..N
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlight((h) => Math.min(h + 1, maxHighlight));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open) {
        e.preventDefault();
        if (highlight === 0) {
          choose(""); // the "(Default)" row
        } else {
          const picked = filtered[highlight - 1];
          if (picked !== undefined) choose(picked);
        }
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        scheduleClose();
      }
    }
  };

  // Outside-click closes (mousedown so it fires before blur reshuffles focus).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        scheduleClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  // Closed → show the committed value; open → show the live search query.
  const displayValue = open ? query : current;
  const placeholder = open ? t("searchFonts") : current === "" ? t("fontDefault") : current;

  return (
    <div className="font-combobox" ref={rootRef}>
      <div className="font-combobox-field">
        <input
          id={SETTING_ID(def.key)}
          className="setting-input font-combobox-input"
          type="text"
          value={displayValue}
          placeholder={placeholder}
          style={current ? { fontFamily: current } : undefined}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          // Blur without a selection → abandon the query, keep the value.
          // Deferred (see scheduleClose) so an option click committing on
          // mousedown wins the race; by the time the close runs the field is
          // already collapsed and this is a no-op.
          onBlur={() => scheduleClose()}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${SETTING_ID(def.key)}-listbox`}
          role="combobox"
        />
        {current !== "" && (
          <button
            type="button"
            className="font-combobox-clear"
            aria-label={t("clearFont")}
            title={t("clearFont")}
            // preventDefault on mousedown so the input's onBlur doesn't fire
            // first and call close() (which would no-op the clear).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose("")}
          >
            <X size={13} />
          </button>
        )}
        <ChevronDown className="font-combobox-chevron" size={14} aria-hidden="true" />
      </div>

      {open && (
        <ul
          id={`${SETTING_ID(def.key)}-listbox`}
          className="font-combobox-list"
          role="listbox"
        >
          <li
            role="option"
            aria-selected={current === ""}
            className={"font-combobox-option" + (highlight === 0 ? " font-combobox-active" : "")}
            onMouseEnter={() => setHighlight(0)}
            // mousedown (not click) + preventDefault keeps focus on the input,
            // so the selection commits before any blur can abandon it.
            onMouseDown={(e) => {
              e.preventDefault();
              choose("");
            }}
          >
            <span className="font-combobox-default-label">{t("fontDefault")}</span>
          </li>
          {fonts === null ? (
            <li className="font-combobox-empty">{t("loadingFonts")}</li>
          ) : filtered.length === 0 ? (
            <li className="font-combobox-empty">{t("noFonts")}</li>
          ) : (
            filtered.map((name, i) => {
              const idx = i + 1; // account for the "(Default)" row above
              const isActive = name === current;
              return (
                <li
                  key={name}
                  role="option"
                  aria-selected={isActive}
                  className={
                    "font-combobox-option" +
                    (highlight === idx ? " font-combobox-active" : "") +
                    (isActive ? " font-combobox-selected" : "")
                  }
                  style={{ fontFamily: name }}
                  onMouseEnter={() => setHighlight(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(name);
                  }}
                  title={name}
                >
                  {name}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
