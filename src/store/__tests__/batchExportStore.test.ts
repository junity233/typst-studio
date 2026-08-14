import { describe, expect, it } from "vitest";
import { uniquifyStems } from "../batchExportStore";

describe("uniquifyStems", () => {
  it("uses the file stem as the output name", () => {
    expect(uniquifyStems(["/ws/notes.typ"])).toEqual([
      { abs: "/ws/notes.typ", name: "notes" },
    ]);
    expect(uniquifyStems(["D:\\ws\\a\\main.typ"])).toEqual([
      { abs: "D:\\ws\\a\\main.typ", name: "main" },
    ]);
  });

  it("disambiguates duplicate stems with -2, -3, … in input order", () => {
    expect(
      uniquifyStems(["/a/main.typ", "/b/main.typ", "/c/main.typ"]),
    ).toEqual([
      { abs: "/a/main.typ", name: "main" },
      { abs: "/b/main.typ", name: "main-2" },
      { abs: "/c/main.typ", name: "main-3" },
    ]);
  });

  it("does not collide with a real suffixed stem (fixpoint bumping)", () => {
    // The generated "main-2" for the second main.typ takes the first free
    // name; the REAL main-2.typ then bumps past it to main-2-2 — uniqueness
    // is the invariant, not who keeps the pretty name.
    expect(
      uniquifyStems(["/a/main.typ", "/b/main.typ", "/c/main-2.typ"]),
    ).toEqual([
      { abs: "/a/main.typ", name: "main" },
      { abs: "/b/main.typ", name: "main-2" },
      { abs: "/c/main-2.typ", name: "main-2-2" },
    ]);
  });

  it("does not collide across distinct stems", () => {
    expect(uniquifyStems(["/a/main.typ", "/a/main-2.typ"])).toEqual([
      { abs: "/a/main.typ", name: "main" },
      { abs: "/a/main-2.typ", name: "main-2" },
    ]);
  });

  it("falls back to 'document' for a bare extension", () => {
    expect(uniquifyStems(["/ws/.typ"])).toEqual([
      { abs: "/ws/.typ", name: "document" },
    ]);
  });
});
