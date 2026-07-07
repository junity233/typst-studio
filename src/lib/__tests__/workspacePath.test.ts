import { describe, expect, it } from "vitest";
import {
  isInWorkspace,
  joinWorkspacePath,
  relativeWithinWorkspace,
  workspacePathsEqual,
} from "../workspacePath";

describe("workspace paths", () => {
  it("joins Windows roots using backslashes throughout", () => {
    expect(joinWorkspacePath("D:\\work\\book", "chapters/one.typ")).toBe(
      "D:\\work\\book\\chapters\\one.typ",
    );
  });

  it("matches canonical Windows paths despite separator and case differences", () => {
    expect(
      workspacePathsEqual(
        "D:\\Work\\Book\\chapters\\one.typ",
        "d:\\work\\book/chapters/one.typ",
      ),
    ).toBe(true);
  });

  it("keeps POSIX comparisons case-sensitive", () => {
    expect(joinWorkspacePath("/work/book", "chapters/one.typ")).toBe(
      "/work/book/chapters/one.typ",
    );
    expect(workspacePathsEqual("/work/Book.typ", "/work/book.typ")).toBe(false);
  });
});

describe("isInWorkspace", () => {
  it("returns false for a null/empty root", () => {
    expect(isInWorkspace(null, "/work/book/a.typ")).toBe(false);
    expect(isInWorkspace("", "/work/book/a.typ")).toBe(false);
  });

  it("matches a POSIX child path", () => {
    expect(isInWorkspace("/work/book", "/work/book/chapters/one.typ")).toBe(true);
  });

  it("rejects a POSIX sibling that shares a name prefix", () => {
    // /work/book notes must NOT contain /work/notes.typ (no separator match).
    expect(isInWorkspace("/work/book", "/work/notes.typ")).toBe(false);
    expect(isInWorkspace("/work/book", "/work/bookstore/x.typ")).toBe(false);
  });

  it("matches a Windows backslash child path (the regression: separator)", () => {
    expect(
      isInWorkspace("C:\\code\\typst-studio", "C:\\code\\typst-studio\\src\\main.typ"),
    ).toBe(true);
  });

  it("matches a Windows child path despite case + mixed separators", () => {
    expect(
      isInWorkspace("C:\\Code\\Typst-Studio", "c:/code/typst-studio/src/main.typ"),
    ).toBe(true);
  });

  it("rejects a Windows sibling sharing the name prefix", () => {
    expect(
      isInWorkspace("C:\\code\\typst-studio", "C:\\code\\typst-studio-extra\\x.typ"),
    ).toBe(false);
  });
});

describe("relativeWithinWorkspace", () => {
  it("strips a POSIX root, returning forward-slash relative", () => {
    expect(relativeWithinWorkspace("/work/book", "/work/book/chapters/one.typ")).toBe(
      "chapters/one.typ",
    );
  });

  it("strips a Windows backslash root, normalizing to forward slashes", () => {
    expect(
      relativeWithinWorkspace("C:\\code\\typst-studio", "C:\\code\\typst-studio\\src\\main.typ"),
    ).toBe("src/main.typ");
  });

  it("is case-insensitive on Windows but preserves the original casing", () => {
    expect(
      relativeWithinWorkspace("C:\\Code\\Typst-Studio", "c:/code/typst-studio/Src/Main.typ"),
    ).toBe("Src/Main.typ");
  });

  it("returns null for the root itself (not a valid entry relative)", () => {
    expect(relativeWithinWorkspace("/work/book", "/work/book")).toBeNull();
    expect(relativeWithinWorkspace("C:\\code\\x", "C:\\code\\x")).toBeNull();
  });

  it("returns null for a path outside the root", () => {
    expect(relativeWithinWorkspace("/work/book", "/etc/passwd")).toBeNull();
    expect(
      relativeWithinWorkspace("C:\\code\\typst-studio", "C:\\code\\other\\x.typ"),
    ).toBeNull();
  });

  it("returns null for a null/empty root", () => {
    expect(relativeWithinWorkspace(null, "/work/book/a.typ")).toBeNull();
  });
});
