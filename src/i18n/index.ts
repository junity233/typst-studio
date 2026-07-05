/**
 * i18n initialization.
 *
 * Wired into the settings pipeline the same way `appearance.theme` is: the
 * current language lives in `appearance.language` (persisted by the backend,
 * broadcast to all windows via `settings_changed`), and `useLanguage` reacts
 * to changes by calling `i18n.changeLanguage`. We only own the i18next
 * instance + resource bundles here.
 *
 * Importing this module (side effect) initializes i18next and registers the
 * React bindings. `main.tsx` imports it once before rendering.
 *
 * Resources are statically imported so Vite bundles them (resolveJsonModule is
 * on in tsconfig). Namespaces are added as Phase 2 lands translations.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json";
import zhCommon from "./locales/zh/common.json";
import enStatusbar from "./locales/en/statusbar.json";
import zhStatusbar from "./locales/zh/statusbar.json";
import enDiagnostics from "./locales/en/diagnostics.json";
import zhDiagnostics from "./locales/zh/diagnostics.json";
import enSidebar from "./locales/en/sidebar.json";
import zhSidebar from "./locales/zh/sidebar.json";
import enSearch from "./locales/en/search.json";
import zhSearch from "./locales/zh/search.json";
import enSourceControl from "./locales/en/sourceControl.json";
import zhSourceControl from "./locales/zh/sourceControl.json";
import enDialog from "./locales/en/dialog.json";
import zhDialog from "./locales/zh/dialog.json";
import enErrors from "./locales/en/errors.json";
import zhErrors from "./locales/zh/errors.json";
import enEditor from "./locales/en/editor.json";
import zhEditor from "./locales/zh/editor.json";
import enPreview from "./locales/en/preview.json";
import zhPreview from "./locales/zh/preview.json";
import enFormatToolbar from "./locales/en/formatToolbar.json";
import zhFormatToolbar from "./locales/zh/formatToolbar.json";
import enCommandBar from "./locales/en/commandBar.json";
import zhCommandBar from "./locales/zh/commandBar.json";
import enSettings from "./locales/en/settings.json";
import zhSettings from "./locales/zh/settings.json";
import enCommand from "./locales/en/command.json";
import zhCommand from "./locales/zh/command.json";
import enTitlebar from "./locales/en/titlebar.json";
import zhTitlebar from "./locales/zh/titlebar.json";
import enApp from "./locales/en/app.json";
import zhApp from "./locales/zh/app.json";

export const SUPPORTED_LANGUAGES = ["en", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** The `appearance.language` setting value indicating "follow the OS". */
export const AUTO_LANGUAGE = "auto" as const;

/**
 * Resolve the `appearance.language` setting value to a concrete i18next
 * language code. `"auto"` (or undefined, before hydrate) inspects
 * `navigator.language`; otherwise the value is used verbatim if it is a known
 * language, falling back to English.
 *
 * Exported (and pure) so `useLanguage` and tests can share one definition.
 */
export function resolveLanguage(setting: string | undefined): SupportedLanguage {
  if (setting && setting !== AUTO_LANGUAGE) {
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(setting)
      ? (setting as SupportedLanguage)
      : "en";
  }
  // navigator.language examples: "zh-CN", "zh-Hans", "en-US", "en-GB".
  // Match any Chinese variant (zh, zh-*, zh-Hans-*, ...).
  const nav = navigator.language?.toLowerCase() ?? "";
  return nav.startsWith("zh") ? "zh" : "en";
}

void i18n.use(initReactI18next).init({
  // Initial language: best guess from the system locale. `useLanguage` will
  // correct this once the persisted `appearance.language` arrives from the
  // backend (usually synchronously enough that the user never sees a flash).
  lng: resolveLanguage(undefined),
  fallbackLng: "en",
  defaultNS: "common",
  ns: ["common", "statusbar", "diagnostics", "sidebar", "search", "sourceControl", "dialog", "errors", "editor", "preview", "formatToolbar", "commandBar", "settings", "command", "titlebar", "app"],
  resources: {
    en: { common: enCommon, statusbar: enStatusbar, diagnostics: enDiagnostics, sidebar: enSidebar, search: enSearch, sourceControl: enSourceControl, dialog: enDialog, errors: enErrors, editor: enEditor, preview: enPreview, formatToolbar: enFormatToolbar, commandBar: enCommandBar, settings: enSettings, command: enCommand, titlebar: enTitlebar, app: enApp },
    zh: { common: zhCommon, statusbar: zhStatusbar, diagnostics: zhDiagnostics, sidebar: zhSidebar, search: zhSearch, sourceControl: zhSourceControl, dialog: zhDialog, errors: zhErrors, editor: zhEditor, preview: zhPreview, formatToolbar: zhFormatToolbar, commandBar: zhCommandBar, settings: zhSettings, command: zhCommand, titlebar: zhTitlebar, app: zhApp },
  },
  // React already escapes interpolated values; no double-escaping needed.
  interpolation: { escapeValue: false },
  // Surface missing keys in dev (console only) so we never ship a raw key.
  saveMissing: import.meta.env.DEV,
  missingKeyHandler:
    import.meta.env.DEV
      ? (_lngs, _ns, key) => {
          console.warn(`[i18n] missing key: "${key}"`);
        }
      : undefined,
  returnNull: false,
});

export default i18n;
