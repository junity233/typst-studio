import { useState } from "react";
import { Plus, X, Hammer, Type, Eye, Monitor, Save, Database, type LucideIcon } from "lucide-react";
import type { ManifestCategory, SettingDef } from "../../lib/settings-types";
import { useSetting } from "../../hooks/useSetting";
import { useSettingsStore } from "../../store/settingsStore";
import {
  clearRecentWorkspaces,
  openLogDir,
} from "../../lib/tauri";
import { toIpcError } from "../../lib/ipc-error";
import { Toggle } from "./Toggle";

/** Icon + accent hue per category id. Falls back to a gear. */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  compiler: Hammer,
  editor: Type,
  preview: Eye,
  window: Monitor,
  saving: Save,
  data: Database,
};

/**
 * Root of the dedicated settings window (loaded via `index.html?window=settings`
 * and branched in `main.tsx`). macOS-System-Settings layout: a parchment
 * category rail (with per-category icons + a count badge) on the left and a
 * grouped-card control pane on the right. Every control binds to `useSetting`
 * and writes straight through to the backend on change (live-apply, no Save).
 */
export function SettingsApp() {
  const manifest = useSettingsStore((s) => s.manifest);
  if (manifest === null) {
    return <div className="settings-window settings-loading">Loading…</div>;
  }
  return <SettingsWindow categories={manifest.categories} />;
}

function SettingsWindow({ categories }: { categories: ManifestCategory[] }) {
  const [activeId, setActiveId] = useState<string>(categories[0]?.id ?? "");
  const active = categories.find((c) => c.id === activeId) ?? categories[0] ?? null;

  return (
    <div className="settings-window">
      <aside className="settings-sidebar">
        <h1 className="settings-sidebar-title">Settings</h1>
        <nav className="settings-categories" aria-label="Settings categories">
          {categories.map((cat) => {
            const Icon = CATEGORY_ICON[cat.id] ?? Hammer;
            const isActive = cat.id === active?.id;
            return (
              <button
                type="button"
                key={cat.id}
                className={"settings-category" + (isActive ? " settings-category-active" : "")}
                onClick={() => setActiveId(cat.id)}
              >
                <span className="settings-category-icon">
                  <Icon size={15} strokeWidth={2} />
                </span>
                <span className="settings-category-label">{cat.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="settings-pane">
        {active ? <CategoryPane category={active} /> : <p className="settings-empty">No settings.</p>}
      </main>
    </div>
  );
}

function CategoryPane({ category }: { category: ManifestCategory }) {
  return (
    <div className="settings-content">
      <header className="settings-content-header">
        <h2 className="settings-content-title">{category.label}</h2>
        <p className="settings-content-sub">
          {category.settings.length} {category.settings.length === 1 ? "preference" : "preferences"}
        </p>
      </header>
      <section className="settings-card">
        {category.settings.map((def, i) => (
          <SettingRow key={def.key} def={def} last={i === category.settings.length - 1} />
        ))}
      </section>
    </div>
  );
}

function SettingRow({ def, last }: { def: SettingDef; last: boolean }) {
  const isAction = def.action !== undefined;
  const isInput =
    def.type !== "boolean" &&
    def.type !== "paths" &&
    !isAction;
  // For action settings the button itself carries the label, so we hide the
  // row label (the key + help still show for context).
  const showLabel = !isAction;
  return (
    <div className={"setting-row" + (last ? " setting-row-last" : "")}>
      <div className="setting-row-text">
        {showLabel && (
          <label className="setting-label" htmlFor={isInput ? `setting-${def.key}` : undefined}>
            {def.label}
          </label>
        )}
        <span className="setting-key">{def.key}</span>
        {def.help && <span className="setting-help">{def.help}</span>}
      </div>
      <div className="setting-control">
        <SettingControl def={def} />
      </div>
    </div>
  );
}

function SettingControl({ def }: { def: SettingDef }) {
  // Action settings render as buttons, not inputs.
  if (def.action !== undefined) return <ActionControl def={def} />;
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

/**
 * An action setting renders as a button that fires the named backend action
 * (§9 "清除最近记录时可选择同时清除恢复数据", §7.4 "打开日志目录"). The action
 * id maps to an IPC call; a confirm dialog guards destructive actions.
 */
function ActionControl({ def }: { def: SettingDef }) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    // Destructive clear actions: confirm first (§2 "明确确认优先").
    if (def.action === "clearRecentWorkspaces" || def.action === "clearRecoveryData") {
      const alsoRecovery = def.action === "clearRecoveryData";
      const ok = window.confirm(
        alsoRecovery
          ? "Delete ALL crash-recovery snapshots? This cannot be undone."
          : "Clear the recent-workspaces list? This cannot be undone.",
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      switch (def.action) {
        case "clearRecentWorkspaces":
          // Clear recent only (recovery untouched).
          await clearRecentWorkspaces(false);
          break;
        case "clearRecoveryData":
          // Clear recovery + the recent list together (§9 option).
          // `clearRecentWorkspaces(true)` clears recovery server-side
          // (session_commands bridges into RecoveryStore::clear_all), so no
          // separate discardAllRecovery round-trip is needed.
          await clearRecentWorkspaces(true);
          break;
        case "openLogDir":
          await openLogDir();
          break;
        default:
          console.warn(`[settings] unknown action: ${def.action}`);
      }
    } catch (e) {
      console.warn(`[settings] action ${def.action} failed:`, e);
      // IPC rejections arrive as the structured IpcError object (Batch 4 wire
      // format), not an Error instance — use toIpcError to avoid [object Object].
      window.alert(`Action failed: ${toIpcError(e).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={"setting-action-btn" + (busy ? " setting-action-busy" : "")}
      onClick={() => void run()}
      disabled={busy}
    >
      {busy ? "Working…" : def.label}
    </button>
  );
}

const SETTING_ID = (key: string) => `setting-${key}`;

function NumberControl({ def, integer }: { def: SettingDef; integer: boolean }) {
  const [value, setValue] = useSetting<number>(def.key);
  const fallback = typeof def.default === "number" ? def.default : 0;
  const current = value ?? fallback;
  return (
    <input
      id={SETTING_ID(def.key)}
      className="setting-input setting-input-number"
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
      placeholder={fallback || "default"}
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
  const fallback = typeof def.default === "string" ? def.default : (options[0] ?? "");
  const current = typeof value === "string" ? value : fallback;
  /** Display label for an option: explicit `optionLabels` entry, else the
   * capitalized option value (the long-standing default). */
  const labelFor = (opt: string) =>
    def.optionLabels?.[opt] ?? (opt.charAt(0).toUpperCase() + opt.slice(1));
  return (
    <select
      id={SETTING_ID(def.key)}
      className="setting-input setting-input-select"
      value={current}
      onChange={(e) => setValue(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {labelFor(opt)}
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
          <button type="button" className="path-add-btn" onClick={add}>
            <Plus size={13} /> Add
          </button>
        </div>
      )}
    </div>
  );
}
