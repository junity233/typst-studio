import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Spec §8.2 / §15 / §17 — `documentUri.ts` is the single source of truth for
 * turning a frontend `DocumentOrigin` into the URI string both Monaco and
 * Tinymist see. Disk files become real `file:` URIs (cross-platform correct,
 * incl. the Windows `file:///C:/...` form); untitled docs become either an
 * `untitled:` URI (default) or a fallback virtual `file:` URI under the app's
 * private virtual root, depending on the active untitled scheme.
 *
 * The real `vscode` `Uri` helper (used in production via `lspClient.ts`) cannot
 * be imported under vitest+jsdom — the `@codingame/monaco-vscode-api` shim
 * transitively loads widget CSS and a Constructable StyleSheets interop that
 * jsdom does not support (`TypeError: sheet.replaceSync is not a function`).
 * We therefore mock `vscode` with a faithful re-implementation of the same
 * `Uri.file` / `Uri.parse` / `.toString()` algorithm VS Code uses, so the test
 * asserts the EXACT wire strings the production code emits. The mock is local
 * to this test file and does not affect production.
 */

// --- faithful vscode.Uri mock (mirrors monaco-vscode-api's fileUriToString) --
vi.mock("vscode", () => {
  interface UriLike {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fsPath: string;
    toString(): string;
  }

  function encodeUriComponent(seg: string): string {
    // VS Code percent-encodes a small set of chars. We keep this minimal — the
    // tested paths contain none of them, so the wire strings are unaffected.
    return seg.replace(/[#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  function toString(scheme: string, authority: string, path: string): string {
    let res = scheme + ":";
    // VS Code emits `//authority` only when an authority is present, EXCEPT the
    // `file:` scheme always writes the `//` separator (file:///path). Other
    // schemes (e.g. `untitled:`) with no authority emit `scheme:path` — no
    // double slash.
    if (authority.length > 0 || scheme === "file") {
      res += "//" + authority;
    }
    res += encodeUriComponent(path);
    return res;
  }

  function file(path: string): UriLike {
    const hasDrive = /^[a-zA-Z]:/.test(path);
    const hasBackslash = path.includes("\\");
    const isWindows = hasDrive || hasBackslash;
    const normalized = path.replace(/\\/g, "/");
    let uriPath: string;
    let authority: string;
    if (isWindows) {
      // file:///C:/... — drive-letter path, empty authority.
      uriPath = normalized.startsWith("/") ? normalized.slice(1) : normalized;
      authority = "";
    } else {
      uriPath = normalized.startsWith("/") ? normalized : "/" + normalized;
      authority = "";
    }
    return {
      scheme: "file",
      authority,
      path: isWindows ? "/" + uriPath : uriPath,
      fsPath: path,
      toString: () => toString("file", authority, isWindows ? "/" + uriPath : uriPath),
    };
  }

  function parse(uriStr: string): UriLike {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/[^/]*)?([^?#]*)?(\?[^#]*)?(#.*)?$/.exec(uriStr);
    if (!m) {
      return {
        scheme: "",
        authority: "",
        path: uriStr,
        fsPath: uriStr,
        toString: () => uriStr,
      };
    }
    const scheme = m[1];
    let authority = "";
    let path = m[3] ?? "";
    if (m[2]) {
      // m[2] is "//authority" → strip leading "//".
      authority = m[2].slice(2);
    } else if (uriStr.startsWith(`${scheme}:/`) && scheme !== "file") {
      // scheme:/path form (e.g. untitled:/id.typ) — no authority, path keeps leading /.
      authority = "";
    }
    return {
      scheme,
      authority,
      path,
      fsPath: path,
      toString: () => toString(scheme, authority, path),
    };
  }

  return { Uri: { file, parse } };
});

import {
  originToUri,
  parseUntitledUriId,
  typstDocumentSelector,
  APP_PRIVATE_VIRTUAL_ROOT,
  getUntitledScheme,
  setUntitledSchemeForTest,
} from "../documentUri";
import type { DocumentOrigin, DocumentId } from "../../../lib/types";

// Fix 1 drift tripwire: `lspClient.ts` cannot be imported directly under
// vitest+jsdom (its monaco-vscode-api transitive imports load widget CSS that
// jsdom can't parse — same constraint documented in this file's header). We
// therefore read `MEM_ROOT`'s literal from `lspClient.ts` source text via
// Vite's `?raw` loader and compare it to APP_PRIVATE_VIRTUAL_ROOT. If the two
// magic strings ever drift, this test fails loudly.
import lspClientSource from "../lspClient.ts?raw";

// Full namespace import so we can assert the EXPORTED symbol surface (spec
// §7.3 / §21 #13: the module must not export `rootPath`).
import * as documentUriModule from "../documentUri";

describe("documentUri — originToUri (§8.2 / §15)", () => {
  beforeEach(() => setUntitledSchemeForTest("untitled"));
  afterEach(() => setUntitledSchemeForTest("untitled"));

  it("workspaceFile with a POSIX path → file:///foo/bar.typ", () => {
    const origin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/foo/bar.typ",
      workspace_id: "ws-1",
    };
    expect(originToUri(origin, "doc-1" as DocumentId)).toBe("file:///foo/bar.typ");
  });

  it("looseFile → real file URI", () => {
    const origin: DocumentOrigin = {
      kind: "looseFile",
      path: "/home/me/notes.typ",
      root: "/home/me",
    };
    expect(originToUri(origin, "doc-2" as DocumentId)).toBe("file:///home/me/notes.typ");
  });

  it("untitled (default scheme) → untitled:/<id>.typ and round-trips", () => {
    const origin: DocumentOrigin = { kind: "untitled" };
    const uri = originToUri(origin, "abc-123" as DocumentId);
    expect(uri).toBe("untitled:/abc-123.typ");
    expect(parseUntitledUriId(uri)).toBe("abc-123");
  });

  it("Windows looseFile path C:\\Users\\me\\doc.typ → file:///C:/Users/me/doc.typ", () => {
    const origin: DocumentOrigin = {
      kind: "looseFile",
      path: "C:\\Users\\me\\doc.typ",
      root: "C:\\Users\\me",
    };
    expect(originToUri(origin, "win-1" as DocumentId)).toBe("file:///C:/Users/me/doc.typ");
  });

  it("switching the untitled scheme to 'file' yields the fallback virtual URI and round-trips", () => {
    setUntitledSchemeForTest("file");
    const origin: DocumentOrigin = { kind: "untitled" };
    const uri = originToUri(origin, "virt-9" as DocumentId);
    expect(uri).toBe(`file://${APP_PRIVATE_VIRTUAL_ROOT}/virt-9.typ`);
    expect(parseUntitledUriId(uri)).toBe("virt-9");
  });
});

describe("documentUri — parseUntitledUriId (§8.2 forbids prefix guessing)", () => {
  beforeEach(() => setUntitledSchemeForTest("untitled"));
  afterEach(() => setUntitledSchemeForTest("untitled"));

  it("returns null for a real file:///foo/bar.typ (NOT under the virtual root)", () => {
    expect(parseUntitledUriId("file:///foo/bar.typ")).toBeNull();
  });

  it("returns null for arbitrary other strings", () => {
    expect(parseUntitledUriId("")).toBeNull();
    expect(parseUntitledUriId("http://example.com/x")).toBeNull();
    expect(parseUntitledUriId("not-a-uri")).toBeNull();
    expect(parseUntitledUriId("file:///typst-studio-mem/")).toBeNull();
  });

  it("returns null for a partial / wrong-segment virtual path", () => {
    // dir only, no <id>.typ — must not over-match.
    expect(parseUntitledUriId(`file://${APP_PRIVATE_VIRTUAL_ROOT}/`)).toBeNull();
  });

  it("extracts the id from an untitled: URI", () => {
    expect(parseUntitledUriId("untitled:/deadbeef.typ")).toBe("deadbeef");
  });

  it("extracts the id from the fallback file: virtual URI", () => {
    setUntitledSchemeForTest("file");
    expect(
      parseUntitledUriId(`file://${APP_PRIVATE_VIRTUAL_ROOT}/zzz-42.typ`),
    ).toBe("zzz-42");
  });
});

describe("documentUri — typstDocumentSelector (§8.2)", () => {
  it("returns both file and untitled schemes with language: typst", () => {
    const selector = typstDocumentSelector();
    expect(selector).toEqual([
      { language: "typst", scheme: "file" },
      { language: "typst", scheme: "untitled" },
    ]);
  });
});

describe("documentUri — import surface guards (§7.3 / §21 #13)", () => {
  // The module MUST NOT export `rootPath` (the global Tinymist root override
  // being removed by §7.3), and originToUri output must never embed a
  // workspace rootPath. This guards against accidental reintroduction.
  it("originToUri output never contains a 'rootPath' substring", () => {
    const origins: DocumentOrigin[] = [
      { kind: "workspaceFile", path: "/foo/bar.typ", workspace_id: "ws" },
      { kind: "looseFile", path: "/home/me/notes.typ", root: "/home/me" },
      { kind: "untitled" },
    ];
    for (const o of origins) {
      const uri = originToUri(o, "doc" as DocumentId);
      expect(uri).not.toContain("rootPath");
    }
  });

  it("the module exports no 'rootPath' symbol", () => {
    // Static import-surface guard: the module namespace must not carry a
    // `rootPath` export (spec §7.3 / §21 #13 forbid the global Tinymist root
    // override from reappearing on this URI module).
    expect(documentUriModule).not.toHaveProperty("rootPath");
    expect(Object.keys(documentUriModule)).not.toContain("rootPath");
  });
});

describe("documentUri — untitled scheme default", () => {
  it("defaults to 'untitled'", () => {
    setUntitledSchemeForTest("untitled");
    expect(getUntitledScheme()).toBe("untitled");
  });
});

describe("documentUri — virtual-root source-of-truth (Fix 1)", () => {
  // APP_PRIVATE_VIRTUAL_ROOT (this module) and MEM_ROOT (lspClient.ts) carry
  // the same magic string until a later task consolidates them. A drift would
  // break fallback-mode untitled round-tripping (parseUntitledUriId's regex is
  // built from APP_PRIVATE_VIRTUAL_ROOT, while lspClient.ts builds the model
  // URI from MEM_ROOT). This tripwire fails loudly on any drift.
  //
  // We read MEM_ROOT from lspClient.ts as raw source text (not via a normal
  // import) because importing lspClient.ts under jsdom pulls in monaco widget
  // CSS that jsdom cannot parse — see this file's header for details.
  it("APP_PRIVATE_VIRTUAL_ROOT stays in sync with lspClient.MEM_ROOT (drift tripwire)", () => {
    const m = /export\s+const\s+MEM_ROOT\s*=\s*("[^"]*"|'[^']*')\s*;/.exec(
      lspClientSource,
    );
    expect(m, "MEM_ROOT literal not found in lspClient.ts source").not.toBeNull();
    // Strip the quotes to get the literal value.
    const memRoot = m![1].slice(1, -1);
    expect(APP_PRIVATE_VIRTUAL_ROOT).toBe(memRoot);
  });
});
