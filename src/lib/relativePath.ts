/**
 * Pure, platform-aware relative-path computation.
 *
 * Used by the paste-image flow to turn the absolute on-disk destination of a
 * pasted image (e.g. `C:/users/me/proj/assets/pasted-abc.png`) into a path
 * **relative to the source document's directory** (`assets/pasted-abc.png`) so
 * the inserted `#image("…")` stays portable: Typst resolves image paths relative
 * to the source `.typ` file, so a relative reference survives project moves and
 * is shareable across machines.
 *
 * Why a hand-rolled helper rather than a dependency: Tauri v2's
 * `@tauri-apps/api/path` module does not export a `relative()` function (it
 * ships `dirname` / `join` / `isAbsolute` / `sep` etc. but not `relative`), and
 * Node's `path` module isn't available in the browser bundle. The algorithm is
 * small and benefits from being unit-testable without Tauri/IO mocks.
 *
 * Returns the relative path with **forward slashes** (Typst-friendly on every
 * platform), or `null` when a relative path can't be expressed — namely when
 * `toAbs` isn't absolute, or when `fromDir` and `toAbs` live on different
 * Windows drives. Callers fall back to the absolute path in that case.
 */

interface ParsedPath {
  /** The root anchor: a Windows drive (`"C:"`) or POSIX root (`"/"`). */
  anchor: string;
  /** Path segments below the anchor, empty strings/trailing slashes removed. */
  segs: string[];
}

/**
 * Split a path into its anchor + segments. Returns `null` for a non-absolute
 * path (relative paths have no anchor and can't be made relative reliably).
 * Backslashes are normalized to forward slashes first so Windows native paths
 * (`C:\Users\…`) parse the same as their forward-slash spelling.
 */
function parsePath(p: string): ParsedPath | null {
  const norm = p.replace(/\\/g, "/");
  // Windows drive-anchored absolute path, e.g. "C:/Users/me".
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(norm);
  if (drive) {
    const rest = drive[2] ?? "";
    return {
      // Normalize drive case — Windows is case-insensitive on drive letters,
      // so "c:" and "C:" denote the same root.
      anchor: drive[1].toUpperCase(),
      segs: rest.split("/").filter((s) => s.length > 0),
    };
  }
  // POSIX absolute path, e.g. "/home/me".
  if (norm.startsWith("/")) {
    return {
      anchor: "/",
      segs: norm.split("/").filter((s) => s.length > 0),
    };
  }
  return null;
}

/**
 * Compute the forward-slash path from `fromDir` (a directory) to `toAbs` (a
 * file/directory). Returns `null` when the two don't share a root anchor
 * (different Windows drive, or either side isn't absolute).
 *
 * @example relativePath("/a/b", "/a/b/c.png")      === "c.png"
 * @example relativePath("/a/b", "/a/b/sub/c.png")  === "sub/c.png"
 * @example relativePath("/a/b", "/a/c.png")        === "../c.png"
 * @example relativePath("C:/x", "D:/y")            === null
 */
export function relativePath(fromDir: string, toAbs: string): string | null {
  const from = parsePath(fromDir);
  const to = parsePath(toAbs);
  if (from === null || to === null) return null;
  if (from.anchor !== to.anchor) return null;

  // Length of the shared leading segment prefix.
  let common = 0;
  while (
    common < from.segs.length &&
    common < to.segs.length &&
    from.segs[common] === to.segs[common]
  ) {
    common++;
  }

  // One ".." for each `fromDir` segment left below the common ancestor.
  const ups = from.segs.length - common;
  const downs = to.segs.slice(common);

  const parts: string[] = [];
  for (let i = 0; i < ups; i++) parts.push("..");
  parts.push(...downs);
  // `toAbs` is a file path in practice, so `downs` is non-empty and we never
  // hit the empty case; guard anyway for defensive correctness.
  return parts.length > 0 ? parts.join("/") : ".";
}
