import type { DocumentOrigin } from "../../lib/types";

/**
 * Monaco's occurrence highlighter resolves model resources through VS Code's
 * TextModelResolverService. Typst Studio owns document contents through its
 * backend + Monaco model registry, while the browser FileService only has the
 * in-memory overlay provider for `file:` URIs. Until open Typst models are
 * mirrored into that overlay, any Typst document origin can produce noisy
 * FileService read errors.
 */
export function shouldDisableOccurrencesHighlight(
  originKind: DocumentOrigin["kind"],
): boolean {
  switch (originKind) {
    case "untitled":
    case "workspaceFile":
    case "looseFile":
      return true;
  }
  const _exhaustive: never = originKind;
  return _exhaustive;
}
