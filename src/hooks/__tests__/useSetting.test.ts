import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getByPath, readSetting } from "../useSetting";
import { useSettingsStore } from "../../store/settingsStore";
import type { Manifest } from "../../lib/settings-types";

/**
 * FIRST tests for the settings read fallback chain — the pure readers that
 * non-component code uses (`searchStore.run`/`replaceAll` read
 * `search.maxPerFile`/`search.maxTotal` blast-guard caps through
 * `readSetting`; `tabsStore.softClose` reads the LRU cap the same way).
 *
 * The pinned contract is the priority chain:
 *
 *     data value  →  manifest default  →  caller fallback
 *
 * with two easily-regressed subtleties:
 *   - falsy-but-DEFINED values (`0`, `false`, `""`) WIN over the manifest
 *     default (the check is `raw !== undefined`, not a truthy test), and
 *   - an explicitly-written `undefined` in `data` does NOT count as set.
 *
 * `getByPath` is also the selector core of the reactive `useSetting` hook —
 * returning the LIVE nested reference (no allocation) is what keeps Zustand's
 * default `Object.is` equality stable, so that too is pinned here.
 */

/** Minimal two-category manifest; the interesting key sits in the SECOND one. */
const manifest: Manifest = {
  version: 1,
  categories: [
    {
      id: "editor",
      label: "Editor",
      settings: [
        {
          key: "editor.fontSize",
          type: "number",
          label: "Font size",
          default: 14,
        },
      ],
    },
    {
      id: "search",
      label: "Search",
      settings: [
        {
          key: "search.maxPerFile",
          type: "integer",
          label: "Max results per file",
          default: 200,
        },
      ],
    },
  ],
};

/** Drive the singleton settings store (manual setup/teardown — no RTL). */
function seed(data: Record<string, unknown>, m: Manifest | null = manifest): void {
  useSettingsStore.setState({ data, manifest: m });
}

describe("getByPath", () => {
  it("resolves deeply nested dot-paths", () => {
    expect(getByPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });

  it("returns undefined for a missing leaf", () => {
    expect(getByPath({ a: { b: {} } }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for a missing intermediate segment", () => {
    expect(getByPath({ a: {} }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is a primitive", () => {
    expect(getByPath({ a: "text" }, "a.b")).toBeUndefined();
    expect(getByPath({ a: { b: 42 } }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for a null root (cur === null branch)", () => {
    expect(getByPath(null, "a.b")).toBeUndefined();
  });

  it("returns the LIVE nested reference (Object.is-stable for selectors)", () => {
    const inner = { c: 1 };
    const obj = { a: { b: inner } };
    expect(getByPath(obj, "a.b")).toBe(inner);
    expect(getByPath(obj, "a.b")).toBe(getByPath(obj, "a.b"));
  });
});

describe("readSetting(path, fallback)", () => {
  beforeEach(() => {
    seed({});
  });

  afterEach(() => {
    // Restore the store's initial state for other test files in this worker.
    useSettingsStore.setState({ data: {}, manifest: null });
  });

  it("returns the data value when set (highest priority)", () => {
    seed({ search: { maxPerFile: 50 } });
    expect(readSetting<number>("search.maxPerFile", 10)).toBe(50);
  });

  it("falls back to the manifest default when data lacks the key", () => {
    // The target key lives in the SECOND category — exercises the
    // cross-category scan of findDefault.
    expect(readSetting<number>("search.maxPerFile", 10)).toBe(200);
    // A first-category key works the same way.
    expect(readSetting<number>("editor.fontSize", 10)).toBe(14);
  });

  it("falls back to the caller's fallback when neither data nor manifest has it", () => {
    // A key absent from BOTH the data and every manifest category — the only
    // configuration that reaches the fallback argument.
    expect(readSetting<string>("nope.unknown", "fallback")).toBe("fallback");
    expect(readSetting<number>("a.b.c", 7)).toBe(7);
  });

  it("falsy-but-defined data values BEAT the manifest default (0/false/\"\")", () => {
    // The guard is `raw !== undefined`, NOT a truthy check — the easiest thing
    // to break in a "simplification". A user capping search hits at 0 must not
    // silently get the manifest's 200 back.
    seed({ search: { maxPerFile: 0 } });
    expect(readSetting<number>("search.maxPerFile", 10)).toBe(0);
    seed({ search: { maxPerFile: false as unknown as number } });
    expect(readSetting<number>("search.maxPerFile", 10)).toBe(false);
    seed({ search: { maxPerFile: "" as unknown as number } });
    expect(readSetting<number>("search.maxPerFile", 10)).toBe("");
  });

  it("falls straight through to the fallback when the manifest is null", () => {
    seed({}, null);
    expect(readSetting<number>("search.maxPerFile", 10)).toBe(10);
  });

  it("treats an explicitly-written undefined in data as UNSET (manifest default applies)", () => {
    seed({ search: { maxPerFile: undefined } });
    expect(readSetting<number>("search.maxPerFile", 10)).toBe(200);
  });
});
