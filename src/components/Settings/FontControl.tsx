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

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (fonts === null) return [];
    const q = query.trim().toLowerCase();
    if (q === "") return fonts;
    return fonts.filter((f) => f.toLowerCase().includes(q));
  }, [fonts, query]);

  // Keep the highlighted index in range as the filter shrinks.
  useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  const choose = (name: string) => {
    setValue(name);
    setOpen(false);
    setQuery("");
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
    }
  };

  const displayValue = open ? query : current;
  // When the field is open we prompt for a search; when closed, an unset value
  // shows "(Default)" and a set value renders the family name itself (displayValue).
  const placeholder = open ? t("searchFonts") : t("fontDefault");

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
            onMouseDown={(e) => {
              e.preventDefault(); // keep input focus
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
