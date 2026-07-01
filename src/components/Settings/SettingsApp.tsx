import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { ManifestCategory, SettingDef } from "../../lib/settings-types";
import { useSetting } from "../../hooks/useSetting";
import { useSettingsStore } from "../../store/settingsStore";
import { Toggle } from "./Toggle";

/**
 * Root of the dedicated settings window (loaded via `index.html?window=settings`
 * and branched in `main.tsx`). macOS-System-Settings layout: a parchment
 * category rail on the left and a white control pane on the right. Every
 * control binds to `useSetting` and writes straight through to the backend on
 * change (live-apply, no Save button).
 */
export function SettingsApp() {
  const manifest = useSettingsStore((s) => s.manifest);

  if (manifest === null) {
    return <div className="settings-window settings-loading">Loading…</div>;
  }

  return <SettingsWindow categories={manifest.categories} />;
}

function SettingsWindow({
  categories,
}: {
  categories: ManifestCategory[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const effectiveId = activeId ?? categories[0]?.id ?? null;
  const active =
    categories.find((c) => c.id === effectiveId) ?? categories[0] ?? null;

  return (
    <div className="settings-window">
      <nav className="settings-categories" aria-label="Settings categories">
        {categories.map((cat) => (
          <button
            type="button"
            key={cat.id}
            className={
              "settings-category" +
              (cat.id === active?.id ? " settings-category-active" : "")
            }
            onClick={() => setActiveId(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </nav>
      <main className="settings-pane">
        {active ? (
          <CategoryPane category={active} />
        ) : (
          <p className="settings-empty">No settings.</p>
        )}
      </main>
    </div>
  );
}

function CategoryPane({ category }: { category: ManifestCategory }) {
  return (
    <>
      <h2 className="settings-pane-title">{category.label}</h2>
      <div className="settings-rows">
        {category.settings.map((def) => (
          <SettingRow key={def.key} def={def} />
        ))}
      </div>
    </>
  );
}

function SettingRow({ def }: { def: SettingDef }) {
  const isInput = def.type !== "boolean" && def.type !== "paths";
  return (
    <div className="setting-row">
      <label
        className="setting-label"
        htmlFor={isInput ? `setting-${def.key}` : undefined}
      >
        {def.label}
      </label>
      <div className="setting-control">
        <SettingControl def={def} />
      </div>
    </div>
  );
}

function SettingControl({ def }: { def: SettingDef }) {
  switch (def.type) {
    case "number":
      return <NumberControl def={def} integer={false} />;
    case "integer":
      return <NumberControl def={def} integer={true} />;
    case "string":
      return <StringControl def={def} />;
    case "boolean":
      return <BooleanControl def={def} />;
    case "select":
      return <SelectControl def={def} />;
    case "paths":
      return <PathsControl def={def} />;
  }
}

const SETTING_ID = (key: string) => `setting-${key}`;

function NumberControl({
  def,
  integer,
}: {
  def: SettingDef;
  integer: boolean;
}) {
  const [value, setValue] = useSetting<number>(def.key);
  const fallback =
    typeof def.default === "number" ? def.default : integer ? 0 : 0;
  const current = value ?? fallback;
  return (
    <input
      id={SETTING_ID(def.key)}
      className="setting-input"
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      value={current}
      min={def.min}
      max={def.max}
      step={def.step ?? (integer ? 1 : "any")}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "" || raw === "-") return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        setValue(integer ? Math.trunc(n) : n);
      }}
    />
  );
}

function StringControl({ def }: { def: SettingDef }) {
  const [value, setValue] = useSetting<string>(def.key);
  const fallback = typeof def.default === "string" ? def.default : "";
  const current = typeof value === "string" ? value : fallback;
  return (
    <input
      id={SETTING_ID(def.key)}
      className="setting-input"
      type="text"
      value={current}
      placeholder={fallback}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

function BooleanControl({ def }: { def: SettingDef }) {
  const [value, setValue] = useSetting<boolean>(def.key);
  const fallback = def.default === true;
  const current = typeof value === "boolean" ? value : fallback;
  return <Toggle checked={current} onChange={setValue} />;
}

function SelectControl({ def }: { def: SettingDef }) {
  const [value, setValue] = useSetting<string>(def.key);
  const options = def.options ?? [];
  const fallback =
    typeof def.default === "string" ? def.default : (options[0] ?? "");
  const current = typeof value === "string" ? value : fallback;
  return (
    <select
      id={SETTING_ID(def.key)}
      className="setting-input"
      value={current}
      onChange={(e) => setValue(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function PathsControl({ def }: { def: SettingDef }) {
  const [value, setValue] = useSetting<string[]>(def.key);
  const readonly = def.readonly === true;
  const list = Array.isArray(value)
    ? value
    : Array.isArray(def.default)
      ? (def.default as string[])
      : [];
  const [draft, setDraft] = useState("");

  const add = () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    setValue([...list, trimmed]);
    setDraft("");
  };

  const remove = (idx: number) => {
    setValue(list.filter((_, i) => i !== idx));
  };

  return (
    <div className="path-list">
      {list.map((p, idx) => (
        <div className="path-chip" key={`${p}-${idx}`}>
          <span className="path-chip-label" title={p}>
            {p}
          </span>
          {!readonly && (
            <button
              type="button"
              className="path-chip-remove"
              aria-label={`Remove ${p}`}
              onClick={() => remove(idx)}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      {!readonly && (
        <div className="path-add">
          <input
            className="setting-input path-add-input"
            type="text"
            placeholder="/path/to/folder"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            className="btn-utility path-add-btn"
            onClick={add}
          >
            <Plus size={12} /> Add
          </button>
        </div>
      )}
    </div>
  );
}
