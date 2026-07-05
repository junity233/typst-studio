/**
 * Localize the settings manifest at render time.
 *
 * The manifest (`src-tauri/settings/manifest.json`) is the single source of
 * truth for the *shape* of settings — shared with the Rust backend via
 * `include_str!`. We deliberately do NOT localize the manifest itself:
 * changing its data shape would ripple into Rust validation, the `get_setting`
 * wire format, and every persisted `settings.json`.
 *
 * Instead, this module maps manifest labels/help to translated strings at the
 * React render boundary. Lookup keys are derived from the manifest:
 *   - category label  →  `category.<catId>`     (e.g. `category.editor`)
 *   - setting label   →  `setting.<def.key>`    (e.g. `setting.editor.fontSize`)
 *   - setting help    →  `settingHelp.<def.key>`
 *   - option label    →  `optionLabel.<def.key>.<opt>`
 *
 * English bundles copy the manifest literals verbatim (so English is the
 * source of truth and never drifts); other languages provide translations.
 * When a key is missing in the active language, i18next falls back to English;
 * if English is also missing, we fall back to the manifest's own literal so
 * a newly-added setting always renders something sensible even before its
 * translation lands.
 */
import i18n from "./index";
import type { ManifestCategory, SettingDef } from "../lib/settings-types";

const NS = "settings";

/**
 * A category's display label, localized. Falls back to the manifest literal
 * when no translation exists (e.g. a freshly added category).
 */
export function localizedCategoryLabel(cat: ManifestCategory): string {
  const key = `category.${cat.id}`;
  return i18n.exists(key, { ns: NS }) ? i18n.t(key, { ns: NS }) : cat.label;
}

/**
 * A setting's display label, localized. Falls back to the manifest literal.
 */
export function localizedSettingLabel(def: SettingDef): string {
  const key = `setting.${def.key}`;
  return i18n.exists(key, { ns: NS }) ? i18n.t(key, { ns: NS }) : def.label;
}

/**
 * A setting's help text, localized, or `undefined` when the manifest carries
 * no help (matching `def.help`'s own optionality).
 */
export function localizedSettingHelp(def: SettingDef): string | undefined {
  if (!def.help) return undefined;
  const key = `settingHelp.${def.key}`;
  return i18n.exists(key, { ns: NS }) ? i18n.t(key, { ns: NS }) : def.help;
}

/**
 * A select option's display label for `def`, localized. Resolution order:
 * localized `optionLabel.<key>.<opt>` → manifest `optionLabels[opt]` →
 * theme friendly name (caller-supplied) → capitalized raw option value.
 *
 * The theme-name fallback is passed in (rather than read here) to keep this
 * helper free of the theme store dependency.
 */
export function localizedOptionLabel(
  def: SettingDef,
  opt: string,
  themeNameFallback?: string,
): string {
  const key = `optionLabel.${def.key}.${opt}`;
  if (i18n.exists(key, { ns: NS })) return i18n.t(key, { ns: NS });
  if (def.optionLabels?.[opt]) return def.optionLabels[opt];
  if (themeNameFallback) return themeNameFallback;
  return opt.charAt(0).toUpperCase() + opt.slice(1);
}
