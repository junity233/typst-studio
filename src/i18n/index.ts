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
 * Resources are statically imported via `import.meta.glob` so Vite bundles
 * them (resolveJsonModule is on in tsconfig). Adding a namespace is a one-file
 * change: drop `./locales/{en,zh}/<ns>.json` and it is picked up here. Mirrors
 * the pattern in `src/extensions/index.ts`.
 */
import i18n, { type Resource, type ResourceLanguage } from "i18next";
import { initReactI18next } from "react-i18next";

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

// Statically collect every locale file. `eager` + `import: "default"` yields a
// map of path -> JSON bundle (inlined by Vite at build time). Mirrors the
// pattern in `src/extensions/index.ts`.
const localeModules = import.meta.glob<ResourceLanguage>(
  "./locales/*/*.json",
  { eager: true, import: "default" },
);

// Build the resources map and derive the namespace list from the same glob, so
// each namespace name lives in exactly one place. Namespaces are sorted for a
// stable bundle order across machines.
const resources: Resource = {};
const namespaces: string[] = [];
for (const [path, bundle] of Object.entries(localeModules)) {
  // "./locales/en/common.json" -> language "en", ns "common".
  const [language, file] = path.split("/").slice(2);
  const namespace = file.replace(/\.json$/, "");
  (resources[language] ??= {})[namespace] = bundle;
  if (!namespaces.includes(namespace)) namespaces.push(namespace);
}
namespaces.sort();

void i18n.use(initReactI18next).init({
  // Initial language: best guess from the system locale. `useLanguage` will
  // correct this once the persisted `appearance.language` arrives from the
  // backend (usually synchronously enough that the user never sees a flash).
  lng: resolveLanguage(undefined),
  fallbackLng: "en",
  defaultNS: "common",
  ns: namespaces,
  resources,
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
