import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../index";
import {
  localizedCategoryLabel,
  localizedOptionLabel,
  localizedSettingHelp,
  localizedSettingLabel,
} from "../settingsManifest";
import type { ManifestCategory, SettingDef } from "../../lib/settings-types";

const cat = (id: string, label: string): ManifestCategory => ({
  id,
  label,
  settings: [],
});

const def = (over: Partial<SettingDef> & Pick<SettingDef, "key" | "label">): SettingDef => ({
  type: "string",
  default: "",
  ...over,
});

describe("settingsManifest localizers", () => {
  beforeEach(async () => {
    // The shared i18n singleton defaults to English on import; reset to en for
    // determinism (other test files in the suite may have switched it).
    await i18n.changeLanguage("en");
  });

  describe("localizedCategoryLabel", () => {
    it("returns the English translation when the key exists", () => {
      expect(localizedCategoryLabel(cat("editor", "Editor"))).toBe("Editor");
    });

    it("falls back to the manifest literal for an unknown category", () => {
      expect(localizedCategoryLabel(cat("experimental", "Experimental"))).toBe("Experimental");
    });

    it("returns the Chinese translation under zh", async () => {
      await i18n.changeLanguage("zh");
      expect(localizedCategoryLabel(cat("editor", "Editor"))).toBe("编辑器");
    });
  });

  describe("localizedSettingLabel", () => {
    it("returns the English translation when the key exists", () => {
      expect(localizedSettingLabel(def({ key: "editor.fontSize", label: "Font size" }))).toBe(
        "Font size",
      );
    });

    it("falls back to the manifest literal for an unknown setting", () => {
      expect(localizedSettingLabel(def({ key: "future.thing", label: "Future thing" }))).toBe(
        "Future thing",
      );
    });

    it("returns the Chinese translation under zh", async () => {
      await i18n.changeLanguage("zh");
      expect(localizedSettingLabel(def({ key: "editor.fontSize", label: "Font size" }))).toBe(
        "字号",
      );
    });
  });

  describe("localizedSettingHelp", () => {
    it("returns undefined when the manifest carries no help", () => {
      expect(localizedSettingHelp(def({ key: "editor.fontSize", label: "Font size" }))).toBe(
        undefined,
      );
    });

    it("returns the English help when the key exists", () => {
      const d = def({
        key: "editor.insertImagePath",
        label: "Inserted image path",
        help: "fallback help",
      });
      // The English bundle carries this key, so the translation wins.
      expect(localizedSettingHelp(d)).toMatch(/Macros:/);
    });

    it("falls back to the manifest help for an unknown key", () => {
      const d = def({ key: "future.thing", label: "x", help: "future help" });
      expect(localizedSettingHelp(d)).toBe("future help");
    });
  });

  describe("localizedOptionLabel", () => {
    it("returns the localized option label when the key exists", () => {
      const d = def({
        key: "appearance.theme",
        type: "select",
        label: "Theme",
        options: ["default"],
        optionLabels: { default: "Default" },
      });
      expect(localizedOptionLabel(d, "default")).toBe("Default");
    });

    it("returns the Chinese option label under zh", async () => {
      await i18n.changeLanguage("zh");
      const d = def({
        key: "appearance.theme",
        type: "select",
        label: "Theme",
        options: ["default"],
      });
      expect(localizedOptionLabel(d, "default")).toBe("默认");
    });

    it("falls back to the theme name when no i18n or optionLabels entry exists", () => {
      const d = def({ key: "appearance.theme", type: "select", label: "Theme", options: [] });
      expect(localizedOptionLabel(d, "my-theme", "My Theme")).toBe("My Theme");
    });

    it("capitalizes the raw option value as the last resort", () => {
      const d = def({ key: "appearance.theme", type: "select", label: "Theme", options: [] });
      expect(localizedOptionLabel(d, "light")).toBe("Light");
    });
  });
});
