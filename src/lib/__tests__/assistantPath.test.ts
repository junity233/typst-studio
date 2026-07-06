import { describe, it, expect } from "vitest";
import {
  resolveWorkspacePath,
  countOccurrences,
  pathsEqual,
} from "../assistantPath";

describe("resolveWorkspacePath", () => {
  it("joins a relative path under a workspace root (posix)", () => {
    expect(resolveWorkspacePath("/workspace", "src/main.typ")).toBe(
      "/workspace/src/main.typ",
    );
  });

  it("normalizes `.` and rejects `..` that escapes the root", () => {
    expect(resolveWorkspacePath("/workspace", "src/../main.typ")).toBe(
      "/workspace/main.typ",
    );
    expect(() => resolveWorkspacePath("/workspace", "../etc/passwd")).toThrow(
      /outside/i,
    );
    expect(() => resolveWorkspacePath("/workspace", "a/../../etc")).toThrow(
      /outside/i,
    );
  });

  it("accepts an absolute path inside the workspace", () => {
    expect(resolveWorkspacePath("/workspace", "/workspace/x.typ")).toBe(
      "/workspace/x.typ",
    );
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveWorkspacePath("/workspace", "/etc/passwd")).toThrow(
      /outside/i,
    );
  });

  it("handles Windows drive-letter roots", () => {
    expect(resolveWorkspacePath("C:/ws", "src/a.typ")).toBe("C:/ws/src/a.typ");
    expect(resolveWorkspacePath("C:\\ws", "src\\a.typ")).toBe("C:/ws/src/a.typ");
    expect(() => resolveWorkspacePath("C:/ws", "D:/evil.typ")).toThrow(/outside/i);
  });

  it("returns the single-file path when no workspace is set (basename or abs)", () => {
    expect(resolveWorkspacePath(null, "main.typ", "/tmp/main.typ")).toBe(
      "/tmp/main.typ",
    );
    expect(resolveWorkspacePath(null, "/tmp/main.typ", "/tmp/main.typ")).toBe(
      "/tmp/main.typ",
    );
  });

  it("rejects other paths when no workspace is set", () => {
    expect(() => resolveWorkspacePath(null, "other.typ", "/tmp/main.typ")).toThrow(
      /outside the single open file/i,
    );
    expect(() => resolveWorkspacePath(null, "main.typ", null)).toThrow(
      /no workspace/i,
    );
  });
});

describe("countOccurrences", () => {
  it("counts zero matches", () => {
    expect(countOccurrences("hello world", "foo")).toBe(0);
  });
  it("counts one match", () => {
    expect(countOccurrences("hello world", "world")).toBe(1);
  });
  it("counts multiple non-overlapping matches", () => {
    expect(countOccurrences("foo bar foo baz foo", "foo")).toBe(3);
  });
  it("handles multi-line search strings", () => {
    expect(countOccurrences("a\nb\na\nb\n", "a\nb")).toBe(2);
  });
  it("returns 0 for an empty needle", () => {
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("pathsEqual", () => {
  it("treats slash and backslash as equal", () => {
    expect(pathsEqual("/ws/a.typ", "/ws\\a.typ")).toBe(true);
  });
  it("is case-insensitive (Windows paths)", () => {
    expect(pathsEqual("C:/WS/A.typ", "c:/ws/a.typ")).toBe(true);
  });
  it("distinguishes different paths", () => {
    expect(pathsEqual("/ws/a.typ", "/ws/b.typ")).toBe(false);
  });
});
