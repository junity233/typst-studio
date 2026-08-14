/** Join a workspace root to the forward-slash relative paths returned by IPC. */
export function joinWorkspacePath(root: string, relative: string): string {
  const windowsPath =
    /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
  const separator = windowsPath ? "\\" : "/";
  const normalizedRelative = relative.replace(/[\\/]/g, separator);
  const needsSeparator = !root.endsWith("/") && !root.endsWith("\\");
  return root + (needsSeparator ? separator : "") + normalizedRelative;
}

/** Compare canonical document paths with platform-appropriate normalization. */
export function workspacePathsEqual(a: string | null, b: string): boolean {
  if (a === null) return false;
  const windowsPath =
    /^[A-Za-z]:[\\/]/.test(a) ||
    /^[A-Za-z]:[\\/]/.test(b) ||
    a.startsWith("\\\\") ||
    b.startsWith("\\\\");
  if (!windowsPath) return a === b;
  return (
    a.replace(/\//g, "\\").toLowerCase() ===
    b.replace(/\//g, "\\").toLowerCase()
  );
}

/**
 * Whether `absPath` is AT or UNDER `rootPath`, with separator- and
 * case-insensitive matching on Windows. Returns `false` when `rootPath` is null
 * or empty. Use this instead of hand-rolled `startsWith(root + "/")` checks,
 * which break on Windows backslash paths (e.g. `C:\\code\\x` never starts with
 * `C:\\code\\x/`).
 */
export function isInWorkspace(rootPath: string | null, absPath: string): boolean {
  if (!rootPath) return false;
  const windowsPath =
    /^[A-Za-z]:[\\/]/.test(rootPath) ||
    /^[A-Za-z]:[\\/]/.test(absPath) ||
    rootPath.startsWith("\\\\") ||
    absPath.startsWith("\\\\");
  if (!windowsPath) {
    return absPath === rootPath || absPath.startsWith(rootPath + "/");
  }
  const normRoot = rootPath.replace(/\//g, "\\").toLowerCase();
  const normAbs = absPath.replace(/\//g, "\\").toLowerCase();
  return normAbs === normRoot || normAbs.startsWith(normRoot + "\\");
}

/**
 * Strip the `rootPath` prefix from `absPath`, returning a workspace-relative
 * path with forward slashes (the form backend commands like `reveal_in_finder`
 * expect), or `null` if `absPath` is not under `rootPath`. Separator- and
 * case-insensitive on Windows. The root itself (`""`) is never a valid entry
 * relative, so it also returns `null` for an exact-root match.
 */
export function relativeWithinWorkspace(
  rootPath: string | null,
  absPath: string,
): string | null {
  if (!isInWorkspace(rootPath, absPath)) return null;
  const windowsPath =
    /^[A-Za-z]:[\\/]/.test(rootPath ?? "") ||
    /^[A-Za-z]:[\\/]/.test(absPath) ||
    absPath.startsWith("\\\\");
  const root = rootPath ?? "";
  // Find the prefix length using normalized comparison so separators/case don't
  // throw off the slice on Windows.
  let prefixLen: number;
  let rest: string;
  if (!windowsPath) {
    if (absPath === root) return null;
    prefixLen = root.length + 1; // skip the separator
    rest = absPath.slice(prefixLen);
  } else {
    const normRoot = root.replace(/\//g, "\\").toLowerCase();
    const normAbs = absPath.replace(/\//g, "\\").toLowerCase();
    if (normAbs === normRoot) return null;
    prefixLen = normRoot.length + 1; // skip the separator
    rest = absPath.slice(prefixLen);
  }
  if (rest.length === 0) return null;
  // Normalize to forward slashes for the backend.
  return rest.replace(/\\/g, "/");
}

/**
 * Convert an absolute `file:` URI (the canonical form tinymist addresses
 * documents by) into a workspace-relative path, or `null` when the URI is
 * malformed or points outside `rootPath`. Pure: `decodeURIComponent` handles
 * the percent-encoding, then [`relativeWithinWorkspace`] does the
 * containment-aware strip. UNC network-share URIs (`file://server/share/x`)
 * are reconstructed with their host so a `\\server\share` workspace root
 * matches.
 */
export function fileUriToWorkspaceRel(
  rootPath: string | null,
  uri: string,
): string | null {
  let pathname: string;
  let host: string;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return null;
    pathname = decodeURIComponent(parsed.pathname);
    host = parsed.hostname;
  } catch {
    return null;
  }
  // file:///D:/x/y.typ → pathname "/D:/x/y.typ"; POSIX file:///x/y → "/x/y".
  let abs = /^[A-Za-z]:\//.test(pathname.slice(1))
    ? pathname.slice(1)
    : pathname;
  // UNC: the server lives in the URL host (file://server/share/x.typ →
  // \\server\share\x.typ). `localhost` is the same machine — drop it.
  if (host !== "" && host !== "localhost") {
    abs = `//${host}${pathname}`;
  }
  return relativeWithinWorkspace(rootPath, abs);
}
