import { describe, it, expect } from "vitest";
import { expandTemplate } from "../index";
import type { MacroContext } from "../types";

const ctx: MacroContext = {
  workspace: "/home/user/proj",
  fileDir: "/home/user/proj/docs",
  fileName: "intro",
  filePath: "/home/user/proj/docs/intro.typ",
  hash: "abc123def456",
  ext: "png",
  timestamp: "20260702",
  index: 0,
};

describe("expandTemplate", () => {
  it("expands simple macros", () => {
    expect(expandTemplate("${fileDir}/x.${ext}", ctx)).toBe("/home/user/proj/docs/x.png");
  });

  it("expands ${workspace}", () => {
    expect(expandTemplate("${workspace}/assets/a.png", ctx)).toBe("/home/user/proj/assets/a.png");
  });

  it("uses default value after colon", () => {
    const partial: MacroContext = { ext: "png" };
    expect(expandTemplate("${fileDir:/tmp}/x.${ext}", partial)).toBe("/tmp/x.png");
  });

  it("keeps unknown macro by default", () => {
    expect(expandTemplate("${unknownThing}/x", ctx)).toBe("${unknownThing}/x");
  });

  it("drops unknown macro when unknown=drop", () => {
    expect(expandTemplate("a${nope}b", ctx, { unknown: "drop" })).toBe("ab");
  });

  it("throws on unknown macro when unknown=throw", () => {
    expect(() => expandTemplate("${nope}", ctx, { unknown: "throw" })).toThrow(/nope/);
  });

  it("throws when strict (?) macro is missing", () => {
    const partial: MacroContext = { ext: "png" };
    expect(() => expandTemplate("${fileDir?}", partial)).toThrow(/fileDir/);
  });

  it("passes through literal ${...} when escaped with $$", () => {
    expect(expandTemplate("$${fileDir}", ctx)).toBe("${fileDir}");
  });

  it("expands index and hash", () => {
    expect(expandTemplate("pasted-${hash}-${index}.${ext}", ctx)).toBe("pasted-abc123def456-0.png");
  });

  it("leaves missing optional macro as empty when no default and unknown=drop", () => {
    const partial: MacroContext = { ext: "png" };
    expect(expandTemplate("[${fileDir}]/x", partial, { unknown: "drop" })).toBe("[]/x");
  });
});
