import { useCallback } from "react";
import { useSettingsStore } from "../store/settingsStore";
import type { Manifest } from "../lib/settings-types";

/**
 * Read a value out of a nested object by dot-path, e.g.
 * `getByPath(data, "editor.fontSize")`. Returns `undefined` for any missing
 * segment or non-object intermediate. Returns the live nested reference (no
 * allocation), so it is safe to use inside a Zustand selector with the default
 * `Object.is` equality.
 */
export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Look up a setting's manifest default by key, or `undefined` if unknown. */
function findDefault(manifest: Manifest | null, key: string): unknown {
  if (!manifest) return undefined;
  for (const cat of manifest.categories) {
    for (const def of cat.settings) {
      if (def.key === key) return def.default;
    }
  }
  return undefined;
}

/**
 * Read a setting value WITHOUT a React hook, for use inside Zustand stores or
 * other non-component code. Resolves the live value at `path`, falling back to
 * the manifest default, then to `fallback`. Prefer `useSetting` in components —
 * this is for store actions and other places hooks can't reach.
 */
export function readSetting<T>(
  path: string,
  fallback: T,
): T {
  const { data, manifest } = useSettingsStore.getState();
  const raw = getByPath(data, path);
  const value = raw !== undefined ? raw : findDefault(manifest, path);
  return (value !== undefined ? (value as T) : fallback);
}

/**
 * Reactive accessor for one setting, `useState`-style.
 *
 *   const [fontSize, setFontSize] = useSetting<number>("editor.fontSize");
 *
 * Reads the value at `path` from the settings store. When the value is unset
 * (undefined), it falls back to the manifest's `default` for that key; if
 * neither exists, returns `undefined`. The setter fires `set_setting` via IPC —
 * the store updates reactively once the backend broadcasts `settings_changed`.
 *
 * Selectors return live nested references (not fresh objects), so the default
 * `Object.is` comparison is stable and re-renders happen only when the data
 * actually changes — no shallow-compare / infinite-loop hazard.
 */
export function useSetting<T>(
  path: string,
): [T | undefined, (value: T) => void] {
  const raw = useSettingsStore((s) => getByPath(s.data, path));
  const fallback = useSettingsStore((s) => findDefault(s.manifest, path));

  const setter = useCallback(
    (value: T) => {
      void useSettingsStore.getState().set(path, value);
    },
    [path],
  );

  const value = (raw !== undefined ? raw : fallback) as T | undefined;
  return [value, setter];
}
