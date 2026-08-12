import { describe, it, expect } from "vitest";
import { relativePath } from "../relativePath";

describe("relativePath", () => {
  it("returns the file name when the target is directly under fromDir", () => {
    expect(relativePath("/a/b", "/a/b/c.png")).toBe("c.png");
  });

  it("descends into a subdirectory of fromDir", () => {
    expect(relativePath("/a/b", "/a/b/sub/c.png")).toBe("sub/c.png");
  });

  it("descends through multiple levels", () => {
    expect(relativePath("/a/b", "/a/b/sub/deep/c.png")).toBe("sub/deep/c.png");
  });

  it("climbs out of a sibling directory with ..", () => {
    expect(relativePath("/a/b/docs", "/a/b/c.png")).toBe("../c.png");
  });

  it("climbs multiple levels", () => {
    expect(relativePath("/a/b/c/d", "/a/x.png")).toBe("../../../x.png");
  });

  it("ignores a trailing slash on fromDir", () => {
    expect(relativePath("/a/b/", "/a/b/c.png")).toBe("c.png");
  });

  it("normalizes backslashes (Windows native paths)", () => {
    expect(relativePath("C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\assets\\x.png"))
      .toBe("assets/x.png");
  });

  it("emits forward slashes even when input uses backslashes", () => {
    expect(relativePath("C:\\a\\b", "C:\\a\\c.png")).toBe("../c.png");
  });

  it("treats Windows drive letters case-insensitively", () => {
    expect(relativePath("c:/a", "C:/a/x.png")).toBe("x.png");
  });

  it("returns null when the two paths are on different Windows drives", () => {
    expect(relativePath("C:/a", "D:/a/x.png")).toBeNull();
  });

  it("returns null when the target is not absolute", () => {
    expect(relativePath("/a/b", "b/c.png")).toBeNull();
  });

  it("returns null when fromDir is not absolute", () => {
    expect(relativePath("a/b", "/a/b/c.png")).toBeNull();
  });

  it("handles POSIX root-relative paths", () => {
    expect(relativePath("/", "/a/b/c.png")).toBe("a/b/c.png");
  });
});
