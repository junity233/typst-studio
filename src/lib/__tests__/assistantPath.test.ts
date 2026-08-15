import { describe, it, expect } from "vitest";
import {
  resolveWorkspacePath,
  countOccurrences,
} from "../assistantPath";

describe("resolveWorkspacePath", () => {
  it("joins a relative path under a workspace root (posix)", () => {
    expect(resolveWorkspacePath("/workspace", "src/main.typ", null)).toBe(
      "/workspace/src/main.typ",
    );
  });

  it("normalizes `.` and rejects `..` that escapes the root", () => {
    expect(resolveWorkspacePath("/workspace", "src/../main.typ", null)).toBe(
      "/workspace/main.typ",
    );
    expect(() => resolveWorkspacePath("/workspace", "../etc/passwd", null)).toThrow(
      /outside/i,
    );
    expect(() => resolveWorkspacePath("/workspace", "a/../../etc", null)).toThrow(
      /outside/i,
    );
  });

  it("accepts an absolute path inside the workspace", () => {
    expect(resolveWorkspacePath("/workspace", "/workspace/x.typ", null)).toBe(
      "/workspace/x.typ",
    );
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveWorkspacePath("/workspace", "/etc/passwd", null)).toThrow(
      /outside/i,
    );
  });

  it("handles Windows drive-letter roots", () => {
    expect(resolveWorkspacePath("C:/ws", "src/a.typ", null)).toBe("C:/ws/src/a.typ");
    expect(resolveWorkspacePath("C:\\ws", "src\\a.typ", null)).toBe("C:/ws/src/a.typ");
    expect(() => resolveWorkspacePath("C:/ws", "D:/evil.typ", null)).toThrow(/outside/i);
  });

  it("preserves the UNC anchor for network-share roots", () => {
    // `//server/share` must NOT collapse to `/server/share` (which re-roots on
    // the current drive on Windows) when empty segments are dropped.
    expect(resolveWorkspacePath("//server/share", "proj/a.typ", null)).toBe(
      "//server/share/proj/a.typ",
    );
    expect(resolveWorkspacePath("\\\\server\\share", "proj\\a.typ", null)).toBe(
      "//server/share/proj/a.typ",
    );
    // An absolute UNC path inside the share is accepted as-is.
    expect(
      resolveWorkspacePath("//server/share", "//server/share/proj/a.typ", null),
    ).toBe("//server/share/proj/a.typ");
    // A different share (or a different server) escapes the workspace.
    expect(() =>
      resolveWorkspacePath("//server/share", "//server/other/a.typ", null),
    ).toThrow(/outside/i);
    expect(() =>
      resolveWorkspacePath("//server/share", "//othersrv/share/a.typ", null),
    ).toThrow(/outside/i);
    // `..` still cannot climb out of the share root.
    expect(() =>
      resolveWorkspacePath("//server/share", "../share2/a.typ", null),
    ).toThrow(/outside/i);
  });

  it("matches UNC containment case-insensitively", () => {
    expect(
      resolveWorkspacePath("//SERVER/share", "//server/SHARE/a.typ", null),
    ).toBe("//server/SHARE/a.typ");
  });

  it("matches Windows containment case-insensitively", () => {
    // A differently-cased absolute path under the root is contained, not an
    // escape (Windows path matching is case-insensitive).
    expect(resolveWorkspacePath("C:/ws", "c:/WS/a.typ", null)).toBe("c:/WS/a.typ");
    expect(resolveWorkspacePath("c:\\WS", "C:/ws/sub/a.typ", null)).toBe("C:/ws/sub/a.typ");
    // Still rejects a different drive regardless of casing.
    expect(() => resolveWorkspacePath("C:/ws", "d:/ws/a.typ", null)).toThrow(/outside/i);
  });

  it("keeps POSIX containment case-sensitive", () => {
    expect(() => resolveWorkspacePath("/workspace", "/Workspace/x.typ", null)).toThrow(
      /outside/i,
    );
  });

  it("matches the single open file case-insensitively on Windows", () => {
    expect(resolveWorkspacePath(null, "MAIN.typ", "C:/tmp/main.typ")).toBe(
      "C:/tmp/main.typ",
    );
    expect(resolveWorkspacePath(null, "c:/TMP/main.typ", "C:/tmp/main.typ")).toBe(
      "C:/tmp/main.typ",
    );
  });

  it("normalizes the single-file candidate before comparing (incl. UNC)", () => {
    // The candidate is lexically normalized too: `./name`, doubled separators,
    // and a collapsed UNC anchor must still equal the normalized single path.
    expect(resolveWorkspacePath(null, "./main.typ", "/tmp/main.typ")).toBe(
      "/tmp/main.typ",
    );
    expect(
      resolveWorkspacePath(null, "//srv//files/main.typ", "//srv/files/main.typ"),
    ).toBe("//srv/files/main.typ");
    expect(
      resolveWorkspacePath(null, "\\\\srv\\files\\main.typ", "//srv/files/main.typ"),
    ).toBe("//srv/files/main.typ");
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
