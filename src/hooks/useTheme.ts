import { useEffect } from "react";
import { useSetting } from "./useSetting";
import { applyTheme, useThemeStore } from "../store/themeStore";

/**
 * Reactively apply the current theme. Reads the `appearance.theme` setting and
 * the discovered theme catalog, and re-applies the theme's CSS whenever either
 * changes. Mount once per window (main + settings) at the root.
 *
 * The effect re-runs when:
 *  - the user picks a different theme in Settings (the setting changes), or
 *  - the theme catalog changes (a theme was added/removed/edited on disk →
 *    `themes_changed` updates the store), so the live-edited CSS is re-fetched
 *    and the new `<style>` content takes effect immediately.
 */
export function useTheme(): void {
  const [themeId] = useSetting<string>("appearance.theme");
  const themes = useThemeStore((s) => s.themes);

  useEffect(() => {
    // `themes` is a dependency so that editing a theme's CSS on disk triggers
    // a re-apply (the catalog reference changes on `themes_changed`).
    void applyTheme(themeId);
    // Resolve the active theme's `base` (light/dark) for Monaco + preview.
    // default / unknown / "all" → light (conservative default; "all" themes
    // don't opt into dark chrome).
    const resolved = themeId && themeId.length > 0 ? themeId : "default";
    const info = resolved === "default" ? undefined : themes.find((t) => t.id === resolved);
    const base: "light" | "dark" = info?.base === "dark" ? "dark" : "light";
    useThemeStore.setState({ currentBase: base });
  }, [themeId, themes]);
}
