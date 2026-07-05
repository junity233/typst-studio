import { describe, expect, it, afterEach } from "vitest";
import { resolveLanguage, AUTO_LANGUAGE } from "../index";

describe("resolveLanguage", () => {
  const originalLanguage = navigator.language;

  afterEach(() => {
    // Restore navigator.language so test order can't matter.
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: originalLanguage,
    });
  });

  function setNavLanguage(value: string) {
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value,
    });
  }

  it("returns an explicit known language verbatim", () => {
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("zh")).toBe("zh");
  });

  it("falls back to English for an unknown explicit value", () => {
    expect(resolveLanguage("fr")).toBe("en");
    expect(resolveLanguage("ja")).toBe("en");
  });

  it('"auto" resolves from navigator.language', () => {
    setNavLanguage("zh-CN");
    expect(resolveLanguage(AUTO_LANGUAGE)).toBe("zh");
    setNavLanguage("zh-Hans");
    expect(resolveLanguage(AUTO_LANGUAGE)).toBe("zh");
    setNavLanguage("en-US");
    expect(resolveLanguage(AUTO_LANGUAGE)).toBe("en");
    setNavLanguage("en-GB");
    expect(resolveLanguage(AUTO_LANGUAGE)).toBe("en");
  });

  it("undefined (pre-hydrate) resolves from navigator.language", () => {
    setNavLanguage("zh-TW");
    expect(resolveLanguage(undefined)).toBe("zh");
    setNavLanguage("fr-FR");
    expect(resolveLanguage(undefined)).toBe("en");
  });

  it("treats empty string like auto/undefined", () => {
    setNavLanguage("zh-CN");
    expect(resolveLanguage("")).toBe("zh");
  });

  it("is case-insensitive when matching the system locale", () => {
    setNavLanguage("ZH-cn");
    expect(resolveLanguage(AUTO_LANGUAGE)).toBe("zh");
  });
});
