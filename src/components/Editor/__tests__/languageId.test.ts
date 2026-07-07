import { describe, it, expect } from "vitest";
import { languageIdFor, languageIdForDocument } from "../languageId";
import type { DocumentOrigin } from "../../../lib/types";

/**
 * The extension→language map is hand-curated (not queried from Monaco at
 * runtime) so it's deterministic and works under jsdom. These tests pin the
 * mapping and the fallback behavior so a careless edit to the table is caught.
 */
describe("languageIdFor", () => {
  it("maps typst kind to the typst language regardless of path", () => {
    expect(languageIdFor("/x/main.typ", "typst")).toBe("typst");
    expect(languageIdFor(null, "typst")).toBe("typst");
  });

  it("maps markdown kind to the markdown language regardless of path", () => {
    expect(languageIdFor("/x/README.md", "markdown")).toBe("markdown");
    expect(languageIdFor(null, "markdown")).toBe("markdown");
  });

  it("maps known text extensions to their Monaco language id", () => {
    const cases: Array<[string, string]> = [
      ["/x/a.json", "json"],
      ["/x/a.ts", "typescript"],
      ["/x/a.tsx", "typescript"],
      ["/x/a.js", "javascript"],
      ["/x/a.py", "python"],
      ["/x/a.css", "css"],
      ["/x/a.html", "html"],
      ["/x/a.yaml", "yaml"],
      ["/x/a.yml", "yaml"],
      ["/x/a.rs", "rust"],
      ["/x/a.go", "go"],
      ["/x/a.sql", "sql"],
    ];
    for (const [path, expected] of cases) {
      expect(languageIdFor(path, "text"), `path ${path}`).toBe(expected);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(languageIdFor("/x/data.JSON", "text")).toBe("json");
    expect(languageIdFor("/x/Data.Json", "text")).toBe("json");
  });

  it("falls back to plaintext for unknown extensions", () => {
    expect(languageIdFor("/x/a.zzz", "text")).toBe("plaintext");
    expect(languageIdFor("/x/Makefile", "text")).toBe("plaintext");
  });

  it("falls back to plaintext for a null path (untitled text doc)", () => {
    expect(languageIdFor(null, "text")).toBe("plaintext");
  });

  it("maps binary kinds to plaintext (the value is unused — no editor renders)", () => {
    // Binary docs never get a Monaco model; languageIdFor is only called for
    // them defensively, so plaintext is a harmless sentinel.
    expect(languageIdFor("/x/photo.png", "image")).toBe("plaintext");
    expect(languageIdFor("/x/doc.pdf", "pdf")).toBe("plaintext");
  });
});

/**
 * `languageIdForDocument` is the shared helper the model-sync planner and the
 * editor's self-sufficient open both call. It centralizes the kind default
 * (`?? "typst"`), the binary-kind→plaintext short-circuit, and the untitled→
 * null-origin path derivation that were previously duplicated inline.
 */
describe("languageIdForDocument", () => {
  const loose: DocumentOrigin = { kind: "looseFile", path: "/x/a.json", root: "/x" };

  it("defaults an unset kind to typst", () => {
    expect(languageIdForDocument({ origin: loose })).toBe("typst");
  });

  it("maps binary kinds to plaintext regardless of path", () => {
    expect(
      languageIdForDocument({ kind: "image", origin: { ...loose, path: "/x/p.png" } }),
    ).toBe("plaintext");
    expect(
      languageIdForDocument({ kind: "pdf", origin: { ...loose, path: "/x/d.pdf" } }),
    ).toBe("plaintext");
  });

  it("maps a text kind via its extension", () => {
    expect(
      languageIdForDocument({ kind: "text", origin: { ...loose, path: "/x/a.ts" } }),
    ).toBe("typescript");
  });

  it("passes a null path for untitled docs (so the extension lookup is skipped)", () => {
    const untitled: DocumentOrigin = { kind: "untitled" };
    expect(languageIdForDocument({ kind: "text", origin: untitled })).toBe(
      "plaintext",
    );
  });
});
