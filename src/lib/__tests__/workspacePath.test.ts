import { describe, expect, it } from "vitest";
import { joinWorkspacePath, workspacePathsEqual } from "../workspacePath";

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
