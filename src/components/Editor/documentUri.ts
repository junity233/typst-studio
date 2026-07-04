import { Uri } from "vscode";
import type { DocumentId, DocumentOrigin } from "../../lib/types";

/**
 * `DocumentOrigin` → URI string (spec §8.2 / §15 / §17).
 *
 * This module is the SINGLE source of truth for the URI both Monaco and
 * Tinymist see for a document. Disk files become real `file:` URIs derived
 * from the origin's canonical absolute `path`; untitled docs become either an
 * `untitled:` URI (default) or — if a later probe determines Tinymist rejects
 * the `untitled:` scheme — a fallback virtual `file:` URI under the app's
 * private virtual root (spec §15).
 *
 * The scheme switch for untitled lives in a module-private `let` accessed only
 * via [`getUntitledScheme`](Self.getUntitledScheme). Production code reads it
 * through the getter and CANNOT reassign it (the `let` is not exported). The
 * only mutation point is [`setUntitledSchemeForTest`](Self.setUntitledSchemeForTest)
 * (test-only), so the scheme can be flipped for tests; the protection is naming
 * convention + the non-exported `let`, not a runtime guard.
 */

/**
 * Virtual path prefix under which fallback (non-`untitled:`) in-memory Typst
 * docs live. Used ONLY when the untitled scheme is `"file"` (the fallback per
 * spec §15); the primary path is `untitled:` and never touches this constant.
 *
 * Intended as the future single source of truth for the virtual root. Until a
 * later task switches [`lspClient.ts`](./lspClient.ts) to import this, BOTH this
 * constant and `lspClient.ts`'s `MEM_ROOT` carry the same magic string and MUST
 * stay string-equal (a drift breaks fallback-mode untitled round-tripping — see
 * parseUntitledUriId's regex and the equality test in documentUri.test.ts).
 */
export const APP_PRIVATE_VIRTUAL_ROOT = "/typst-studio-mem";

/** Which URI scheme untitled docs use. See module doc. */
export type UntitledScheme = "untitled" | "file";

/**
 * The active untitled scheme. Module-private: read via
 * [`getUntitledScheme`](Self.getUntitledScheme), mutated only by
 * [`setUntitledSchemeForTest`](Self.setUntitledSchemeForTest). Default is
 * `"untitled"` (spec §8.2 / §15).
 */
let untitledScheme: UntitledScheme = "untitled";

/**
 * Read the active untitled scheme. Production code MUST go through this getter
 * — the underlying `let` is intentionally not exported, so the only way to
 * mutate it is [`setUntitledSchemeForTest`](Self.setUntitledSchemeForTest).
 */
export function getUntitledScheme(): UntitledScheme {
  return untitledScheme;
}

/**
 * TEST-ONLY setter for the untitled scheme (the value read by
 * [`getUntitledScheme`](Self.getUntitledScheme)). Production code MUST NOT call
 * this — the scheme is intended to be flipped only by a real-Tinymist
 * compatibility probe in a later task. The only protection here is naming
 * convention plus the fact that the backing `let` is not exported; this named
 * function is the SOLE mutation point, which keeps it greppable.
 */
export function setUntitledSchemeForTest(scheme: UntitledScheme): void {
  untitledScheme = scheme;
}

/**
 * Convert a [`DocumentOrigin`] into the canonical URI string Monaco and Tinymist
 * both see.
 *
 * - `workspaceFile` / `looseFile`: a real `file:` URI from the canonical
 *   absolute `path`. We use the `vscode` `Uri.file()` helper (already used by
 *   [`lspClient.ts`](./lspClient.ts)) so encoding is cross-platform correct —
 *   on Windows `C:\foo\bar.typ` becomes `file:///C:/foo/bar.typ`, on POSIX
 *   `/foo/bar.typ` becomes `file:///foo/bar.typ`.
 * - `untitled`: when the untitled scheme is `"untitled"` (default), an
 *   `untitled:/<id>.typ` URI constructed directly (the wire form is fixed by
 *   spec §8.2 and must be stable + round-trippable, so we do not rely on
 *   `Uri.parse` normalization). When the scheme is `"file"` (fallback), a
 *   virtual `file:` URI under [`APP_PRIVATE_VIRTUAL_ROOT`](Self.APP_PRIVATE_VIRTUAL_ROOT).
 *
 * The output NEVER embeds a Tinymist global `rootPath` (spec §7.3 forbids the
 * global override; §21 #13 confirms its removal). `looseFile.root` / workspace
 * association drive LSP folder selection elsewhere, not this URI.
 */
export function originToUri(
  origin: DocumentOrigin,
  id: DocumentId,
): string {
  switch (origin.kind) {
    case "workspaceFile":
    case "looseFile":
      // Both carry a canonical absolute `path`; Uri.file produces the correct
      // file: URI cross-platform.
      return Uri.file(origin.path).toString();
    case "untitled": {
      if (getUntitledScheme() === "untitled") {
        // Direct construction: the wire form `untitled:/<id>.typ` is fixed by
        // spec §8.2. Stable and round-trips through parseUntitledUriId.
        return `untitled:/${id}.typ`;
      }
      // Fallback: app-private virtual file URI (spec §15). Uri.file yields
      // `file:///typst-studio-mem/<id>.typ`.
      return Uri.file(`${APP_PRIVATE_VIRTUAL_ROOT}/${id}.typ`).toString();
    }
  }
}

/**
 * A Monaco / VS Code `documentSelector` covering both schemes Typst models may
 * use. At runtime real `file:` URIs (disk docs) and `untitled:` URIs (untitled
 * docs) — or, in fallback mode, virtual `file:` URIs — coexist, so the selector
 * must match both `file` and `untitled` schemes by language id `typst`.
 */
export function typstDocumentSelector(): Array<{
  language: "typst";
  scheme: "file" | "untitled";
}> {
  return [
    { language: "typst", scheme: "file" },
    { language: "typst", scheme: "untitled" },
  ];
}

/**
 * Parse a [`DocumentId`] out of one of OUR untitled URIs — ONLY ours.
 *
 * Handles BOTH scheme variants:
 * - `untitled:/<id>.typ` → the segment between the leading `/` and `.typ`.
 * - `file:///<APP_PRIVATE_VIRTUAL_ROOT>/<id>.typ` (the fallback form) → the
 *   segment after the virtual root prefix and before `.typ`.
 *
 * Returns `null` for ANY other URI — in particular real `file:` URIs that are
 * NOT under the app-private virtual root. Per spec §8.2, the URI → DocumentId
 * mapping for real `file:` URIs is maintained by the model registry's own
 * uri→id map, NOT by string-prefix guessing here. This helper exists solely so
 * the diagnostics bridge can map an untitled doc's diagnostics back to its id.
 */
export function parseUntitledUriId(uriStr: string): DocumentId | null {
  if (typeof uriStr !== "string" || uriStr.length === 0) return null;

  // Primary: untitled:/<id>.typ
  const untitledMatch = /^untitled:\/([^/]+)\.typ$/.exec(uriStr);
  if (untitledMatch) {
    return untitledMatch[1];
  }

  // Fallback: file:///<APP_PRIVATE_VIRTUAL_ROOT>/<id>.typ  — match the virtual
  // root EXACTLY (with the single trailing slash) and a single path segment,
  // so a real file: URI is never misidentified. Note `Uri.file` canonicalizes
  // `/typst-studio-mem/<id>.typ` to `file:///typst-studio-mem/<id>.typ` (the
  // leading slash of the absolute path is consumed by the `file:///` form), so
  // we strip the root's leading slash before embedding it.
  const root = APP_PRIVATE_VIRTUAL_ROOT.replace(/^\//, "");
  const fileMatch = new RegExp(
    `^file:///${escapeRegExp(root)}/([^/]+)\\.typ$`,
  ).exec(uriStr);
  if (fileMatch) {
    return fileMatch[1];
  }

  return null;
}

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
