import { describe, it, expect, beforeEach } from "vitest";
import {
  PREVIEW_WIDTH_KEY,
  DIAG_HEIGHT_KEY,
  readStoredNumber,
} from "../layoutPrefs";

describe("readStoredNumber", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the finite value when set and parsable", () => {
    localStorage.setItem(PREVIEW_WIDTH_KEY, "512.5");
    expect(readStoredNumber(PREVIEW_WIDTH_KEY)).toBe(512.5);
  });

  it("returns null when the key is unset", () => {
    expect(readStoredNumber(PREVIEW_WIDTH_KEY)).toBeNull();
  });

  it("returns null for unparsable values (no NaN leakage)", () => {
    localStorage.setItem(DIAG_HEIGHT_KEY, "abc");
    expect(readStoredNumber(DIAG_HEIGHT_KEY)).toBeNull();
    localStorage.setItem(DIAG_HEIGHT_KEY, "");
    expect(readStoredNumber(DIAG_HEIGHT_KEY)).toBeNull();
  });

  it("returns null when localStorage.getItem throws (blocked storage)", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    try {
      expect(readStoredNumber(PREVIEW_WIDTH_KEY)).toBeNull();
    } finally {
      window.localStorage.getItem = original;
    }
  });
});
