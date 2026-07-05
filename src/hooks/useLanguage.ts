import { useEffect } from "react";
import { useSetting } from "./useSetting";
import i18n, { resolveLanguage } from "../i18n";

/**
 * Reactively apply the current UI language. Reads the `appearance.language`
 * setting (one of `"auto"` / `"en"` / `"zh"`) and calls `i18n.changeLanguage`
 * whenever it changes — including across windows, since the settings store
 * is repopulated by the backend-broadcast `settings_changed` event.
 *
 * Mirrors `useTheme`: read a setting, apply a side effect on change. Mount
 * once per window (main + settings) at the root.
 *
 * Behavior of `"auto"`: the concrete language is derived from
 * `navigator.language` at the time the setting changes. Picking `auto` again
 * after a system-locale change re-resolves on the next settings event.
 */
export function useLanguage(): void {
  const [language] = useSetting<string>("appearance.language");

  useEffect(() => {
    void i18n.changeLanguage(resolveLanguage(language));
  }, [language]);
}
