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
