/**
 * Lexical workspace path resolution for AI tools. This is a TS-side PRE-CHECK
 * only — the Rust `ensure_contained_path` (`domain/path.rs:78`) is the real
 * security boundary for any write that crosses IPC. We reject obvious escapes
 * (`..`) here so the agent gets a fast, friendly error instead of a round-trip
 * rejection from Rust.
 *
 * The agent supplies paths that are either:
 *   - relative to the workspace root (`"src/main.typ"`), or
 *   - absolute and contained within it (`"/workspace/src/main.typ"`).
 *
 * When no workspace is open, only the single open file path is permitted.
 */

/** Normalize a path's separators to forward-slash for processing. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Collapse `.` and `..` segments lexically (no symlink resolution). */
function lexicalNormalize(p: string): string {
  // Preserve a leading UNC anchor (`//server/share`, `\\server\share`): the
  // segment loop below drops empty segments, which would collapse the anchor
  // into `/server/share` — on Windows that re-roots the path on the current
  // drive instead of the network share, so every derived path would be wrong.
  const unc = p.startsWith("//") || p.startsWith("\\\\");
  const source = unc ? p.slice(2).replace(/\\/g, "/") : p;
  const isAbs = !unc && source.startsWith("/");
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(source);
  const drive = driveMatch ? driveMatch[1] : "";
  const body = driveMatch ? (driveMatch[2] ?? "/") : source;
  const parts = body.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0 || out[out.length - 1] === "..") {
        out.push("..");
      } else {
        out.pop();
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (unc) return `//${joined}`;
  if (drive) return `${drive}/${joined}`;
  if (isAbs) return `/${joined}`;
  return joined || ".";
}

/**
 * Whether a normalized (forward-slash) path is Windows-shaped: a drive letter
 * (`C:/…`) or a UNC share (`//server/…`). Windows path matching is
 * case-insensitive; POSIX paths compare exactly (same convention as
 * `workspacePath.ts`).
 */
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:\//.test(p) || p.startsWith("//");
}

/**
 * Resolve an agent-supplied path against the workspace root (or single open
 * file), rejecting anything that escapes. Throws with a user/agent-readable
 * message on violation.
 *
 * @param rootPath        Workspace root, or null if no workspace is open.
 * @param relOrAbs        Path from the agent (relative to root, or absolute).
 * @param singleFilePath  When no workspace is open, the only permitted path.
 */
export function resolveWorkspacePath(
  rootPath: string | null,
  relOrAbs: string,
  singleFilePath: string | null,
): string {
  if (rootPath) {
    const root = lexicalNormalize(norm(rootPath).replace(/\/$/, ""));
    const candidate = norm(relOrAbs);
    const abs = candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)
      ? candidate
      : `${root}/${candidate}`;
    const normalized = lexicalNormalize(abs);
    // Windows paths are case-insensitive: compare folded (lowercased) forms
    // so a differently-cased path isn't wrongly rejected as an escape; POSIX
    // paths compare exactly.
    const fold = isWindowsPath(root)
      ? (p: string) => p.toLowerCase()
      : (p: string) => p;
    // Permit exactly the root, or anything under `root/`.
    if (fold(normalized) !== fold(root) && !fold(normalized).startsWith(fold(root) + "/")) {
      throw new Error(`Path "${relOrAbs}" resolves outside the workspace.`);
    }
    return normalized;
  }

  // No workspace: only the single open file is permitted.
  if (!singleFilePath) {
    throw new Error("No workspace is open and no single file is available.");
  }
  const single = lexicalNormalize(norm(singleFilePath));
  const singleBasename = single.split("/").pop() ?? single;
  // Normalize the candidate too (not just separator-swap): an agent-supplied
  // `./name` or `//server//share/name` must still equal the normalized single
  // path — a bare `norm` left those forms un-collapsed and wrongly rejected.
  const candidate = lexicalNormalize(norm(relOrAbs));
  const fold = isWindowsPath(single)
    ? (p: string) => p.toLowerCase()
    : (p: string) => p;
  if (fold(candidate) === fold(single) || fold(candidate) === fold(singleBasename)) {
    return single;
  }
  throw new Error(
    `Path "${relOrAbs}" is outside the single open file (${singleBasename}).`,
  );
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

/** Case-insensitive, separator-normalized path equality. */
export function pathsEqual(a: string, b: string): boolean {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}
