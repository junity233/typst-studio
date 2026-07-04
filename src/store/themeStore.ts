import { create } from "zustand";
import {
  getThemeCss,
  listThemes,
  onThemesChanged,
} from "../lib/tauri";
import type { ThemeInfo } from "../lib/types";

/**
 * Theme store: holds the discovered user-theme list and applies the current
 * theme's CSS to the document by injecting a single `<style id="user-theme">`
 * element into `<head>`.
 *
 * Why runtime `<style>` injection (not a `data-theme` attribute + precompiled
 * CSS): user themes are discovered at runtime as free-form CSS, so they can't
 * be precompiled into `[data-theme="x"]` selectors. Injecting a `<style>` AFTER
 * `global.css` lets the user's `:root { --color-... }` overrides win by source
 * order, and also permits any extra selectors they author. The `"default"` id
 * means "no user CSS" and removes the element.
 *
 * The current theme *id* is owned by the settings store (`appearance.theme`),
 * not here — this store only owns the theme *catalog* and the DOM side effect.
 * `useTheme` wires the two together (re-applies whenever the id or the catalog
 * changes).
 *
 * Each window (main + settings) calls `hydrate()` once and `useTheme()` once;
 * they maintain independent `<style>` elements, so both windows reflect the
 * same theme.
 */
const THEME_STYLE_ID = "user-theme";

export interface ThemeState {
  /** Discovered user themes, sorted by display name. Empty until hydrated. */
  themes: ThemeInfo[];
  /** Load the theme list once and subscribe to `themes_changed` for hot reload.
   *  Idempotent per window. */
  hydrate: () => Promise<void>;
}

/** True once `hydrate` has subscribed this window to `themes_changed`. */
let subscribed = false;

export const useThemeStore = create<ThemeState>()(() => ({
  themes: [],

  hydrate: async () => {
    // Fetch the current list; degrade gracefully so a transient IPC failure
    // can't permanently brick the window (the picker just shows Default).
    const themes = await listThemes().catch((e) => {
      console.warn("[themes.hydrate] listThemes failed:", e);
      return [] as ThemeInfo[];
    });
    useThemeStore.setState({ themes });

    // Subscribe exactly once per window — hydrate may be called from both a
    // root effect and a nested component on mount.
    if (!subscribed) {
      subscribed = true;
      onThemesChanged((payload) => {
        useThemeStore.setState({ themes: payload.themes });
      }).catch((e) => {
        console.warn("[themes.hydrate] subscribe failed:", e);
        subscribed = false; // allow a later hydrate to retry
      });
    }
  },
}));

/**
 * Monotonic request token guarding `applyTheme` against out-of-order
 * completion. Each call increments and captures the token; after the
 * `getThemeCss` await, a stale token (a newer `applyTheme` started) means the
 * in-flight result is discarded — so a slow fetch can never overwrite a theme
 * chosen later, and switching to "default" can't be clobbered by a prior
 * fetch resolving after it. Per-window (module-scoped), which is correct since
 * each window owns its own `<style>` element.
 */
let applyToken = 0;

/**
 * Apply a theme by id: inject/replace the `<style id="user-theme">` element
 * with the theme's CSS, or remove it for `"default"` / a failed fetch.
 *
 * Safe to call repeatedly and to re-enter while a previous call's `getThemeCss`
 * is still in flight: a request-token guard ensures only the *latest* call's
 * result is applied, so rapid switching (e.g. default → A → B) can never leave
 * stale CSS on the page or create duplicate `<style>` elements. Runs in both
 * windows independently (each window owns its `<style>`).
 */
export async function applyTheme(id: string | undefined): Promise<void> {
  const resolved = id && id.length > 0 ? id : "default";
  const myToken = ++applyToken;

  if (resolved === "default") {
    document.getElementById(THEME_STYLE_ID)?.remove();
    return;
  }

  const css = await getThemeCss(resolved);
  // A newer applyTheme started while this fetch was in flight — drop the stale
  // result. This also covers "switched to default": that call removed the
  // element and we must not re-add it here.
  if (myToken !== applyToken) return;

  if (css === null) {
    // Unknown/unreadable theme (e.g. just deleted) → fall back to default.
    document.getElementById(THEME_STYLE_ID)?.remove();
    return;
  }

  // Re-query the element now (the DOM may have changed during the await — e.g.
  // a concurrent applyTheme removed it). Reusing a stale `existing` reference
  // here could either resurrect a removed node or append a duplicate.
  const style = document.getElementById(THEME_STYLE_ID);
  if (style) {
    style.textContent = css;
  } else {
    const created = document.createElement("style");
    created.id = THEME_STYLE_ID;
    created.textContent = css;
    document.head.appendChild(created);
  }
}
