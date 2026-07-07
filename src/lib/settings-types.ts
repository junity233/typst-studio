/**
 * Hand-written TS types for the settings manifest. The runtime config is a
 * dynamic `serde_json::Value` (no Rust struct, no ts-rs export), so this
 * descriptor shape is the only typed surface and is authored by hand to mirror
 * `src-tauri/settings/manifest.json` exactly. New settings = edit the JSON; the
 * types here cover the whole `type` union and its optional constraints.
 */

/** The value types a setting can hold. */
export type SettingType =
  | "number"
  | "integer"
  | "string"
  | "boolean"
  | "paths"
  | "select"
  | "font"
  | "path";

/** A single setting descriptor — one row in a category. */
export interface SettingDef {
  /** Dot-separated path into the runtime config, e.g. "editor.fontSize". */
  key: string;
  type: SettingType;
  label: string;
  /** JSON value matching `type`. */
  default: unknown;
  /** Inclusive numeric lower bound (number/integer only). */
  min?: number;
  /** Inclusive numeric upper bound (number/integer only). */
  max?: number;
  /** Per-change step granularity (number/integer only). */
  step?: number;
  /** Allowed values (select only). */
  options?: string[];
  /** Optional display labels keyed by option value (select only). When present,
   * the dropdown shows the label instead of the raw value. Falls back to the
   * capitalized option value for any option without an explicit label.
   */
  optionLabels?: Record<string, string>;
  /** When true the control is display-only (e.g. window.recentWorkspaces). */
  readonly?: boolean;
  /**
   * An action id for button-style settings (e.g. "clearRecoveryData"). When
   * present the row renders a button that fires the named action instead of an
   * input. See SettingsApp's ActionControl.
   */
  action?: string;
  /**
   * Picker kind for `path`-type settings: `"folder"` opens a folder picker,
   * `"file"` opens a file picker. Ignored by other types. Defaults to
   * `"folder"` when omitted.
   */
  pick?: "folder" | "file";
  /** Optional one-line description shown under the label. */
  help?: string;
}

/** A group of related settings rendered under one heading. */
export interface ManifestCategory {
  id: string;
  label: string;
  settings: SettingDef[];
}

/** The whole manifest — the single source of truth that drives the settings UI. */
export interface Manifest {
  version: number;
  categories: ManifestCategory[];
}
