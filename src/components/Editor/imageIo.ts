import { join, dirname, isAbsolute, appConfigDir } from "@tauri-apps/api/path";
import { writeFile, mkdir } from "@tauri-apps/plugin-fs";

export async function resolveImageDir(
  ctx: { workspace?: string; filePath?: string },
  tab: { path: string | null },
): Promise<string | undefined> {
  if (tab.path) {
    return await dirname(tab.path);
  }
  return ctx.workspace ?? undefined;
}

export async function writeImage(absPath: string, bytes: Uint8Array): Promise<void> {
  const dir = await dirname(absPath);
  await mkdir(dir, { recursive: true });
  await writeFile(absPath, bytes);
}

/**
 * Ensure a template-expanded path is absolute. For an untitled tab with no
 * workspace open, fall back to a `pasted-images/` subdirectory of the app's
 * config dir (NOT the OS temp dir): the backend's `fetch_url_to_file` /
 * `writeImage` containment check allows writes only under the workspace root
 * or the app config dir, so this keeps the frontend fallback in agreement
 * with that allow-list. The temp dir is also a poor home for user content
 * (the OS may purge it), whereas the config dir persists across sessions.
 */
export async function ensureAbsolute(
  resolved: string,
  workspace?: string,
): Promise<string> {
  if (await isAbsolute(resolved)) return resolved;
  if (workspace) return join(workspace, resolved);
  return join(await appConfigDir(), "pasted-images", resolved);
}
