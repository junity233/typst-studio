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
  const isAbs = p.startsWith("/");
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(p);
  const drive = driveMatch ? driveMatch[1] : "";
  const body = driveMatch ? (driveMatch[2] ?? "/") : isAbs ? p : p;
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
  if (drive) return `${drive}/${joined}`;
  if (isAbs) return `/${joined}`;
  return joined || ".";
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
    // Permit exactly the root, or anything under `root/`.
    if (normalized !== root && !normalized.startsWith(root + "/")) {
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
  const candidate = norm(relOrAbs);
  if (candidate === single || candidate === singleBasename) {
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
