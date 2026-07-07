import { describe, expect, it } from "vitest";
import {
  allLoadedEntries,
  joinRel,
  parentRel,
  resolveCollision,
  splitRel,
} from "../explorerOps";
import type { DirEntry } from "../../../lib/types";

function entry(relative: string, kind: "file" | "dir"): DirEntry {
  const name = relative.includes("/") ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
  return { relative, name, kind };
}

describe("explorerOps parentRel / splitRel / joinRel", () => {
  it("parentRel returns '' at the root level", () => {
    expect(parentRel("foo.typ")).toBe("");
    expect(parentRel("sub")).toBe("");
    expect(parentRel("")).toBe("");
  });

  it("parentRel strips the last path component", () => {
    expect(parentRel("a/b.typ")).toBe("a");
    expect(parentRel("a/b/c.typ")).toBe("a/b");
  });

  it("splitRel / joinRel round-trip", () => {
    for (const rel of ["foo.typ", "a/b.typ", "a/b/c.typ"]) {
      const { parent, base } = splitRel(rel);
      expect(joinRel(parent, base)).toBe(rel);
    }
  });

  it("joinRel treats '' parent as the root", () => {
    expect(joinRel("", "x.typ")).toBe("x.typ");
    expect(joinRel("a", "x.typ")).toBe("a/x.typ");
  });
});

describe("explorerOps allLoadedEntries", () => {
  it("collects every loaded entry's relative path", () => {
    const tree: Record<string, DirEntry[]> = {
      "": [entry("a.typ", "file"), entry("sub", "dir")],
      sub: [entry("sub/b.typ", "file")],
    };
    expect(allLoadedEntries(tree)).toEqual(
      new Set(["a.typ", "sub", "sub/b.typ"]),
    );
  });
});

describe("explorerOps resolveCollision", () => {
  it("returns the desired name unchanged when it does not collide", () => {
    const existing = new Set(["a.typ", "b.typ"]);
    expect(resolveCollision("c.typ", existing)).toBe("c.typ");
  });

  it("appends 'copy' (no number) on the first collision for a file", () => {
    const existing = new Set(["foo.typ"]);
    expect(resolveCollision("foo.typ", existing)).toBe("foo copy.typ");
  });

  it("appends 'copy 2', 'copy 3', … on further collisions", () => {
    const existing = new Set(["foo.typ", "foo copy.typ"]);
    expect(resolveCollision("foo.typ", existing)).toBe("foo copy 2.typ");
    existing.add("foo copy 2.typ");
    expect(resolveCollision("foo.typ", existing)).toBe("foo copy 3.typ");
  });

  it("handles directories (no extension)", () => {
    const existing = new Set(["assets"]);
    expect(resolveCollision("assets", existing)).toBe("assets copy");
    existing.add("assets copy");
    expect(resolveCollision("assets", existing)).toBe("assets copy 2");
  });

  it("preserves the parent directory of the desired path", () => {
    const existing = new Set(["sub/foo.typ"]);
    expect(resolveCollision("sub/foo.typ", existing)).toBe("sub/foo copy.typ");
  });

  it("only treats a leading-dot extension as an extension when not at index 0", () => {
    // ".gitignore" — dot is at index 0, so there's no stem; the whole name is
    // the stem and the collision suffix goes before any extension.
    const existing = new Set([".gitignore"]);
    // dot=0 → stem = "" , ext = ".gitignore" → " copy.gitignore" would be wrong.
    // Our rule: dot must be > 0, so ".gitignore" is treated as stem=".gitignore",
    // ext="" → ".gitignore copy".
    expect(resolveCollision(".gitignore", existing)).toBe(".gitignore copy");
  });

  it("always renames on Duplicate (never returns the colliding desired name)", () => {
    // Duplicate passes the entry's own relative as the desired name; since the
    // entry itself is in `existing`, the resolver MUST produce a new name.
    const existing = new Set(["note.typ"]);
    const result = resolveCollision("note.typ", existing);
    expect(result).not.toBe("note.typ");
    expect(result).toBe("note copy.typ");
  });
});
