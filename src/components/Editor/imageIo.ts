import { join, dirname, isAbsolute, appConfigDir } from "@tauri-apps/api/path";
import { writeBytesToFile } from "../../lib/tauri";
import { relativePath } from "../../lib/relativePath";

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
  // Route through the backend (containment-checked std::fs) instead of the fs
  // plugin: the plugin is scoped to $HOME/**, which rejects workspaces on other
  // drives. mkdir of the parent dir happens Rust-side. See write_bytes_to_file.
  await writeBytesToFile(absPath, bytes);
}

/**
 * Derive the `#image("…")` source string for a just-written image: prefer a
 * path **relative to the source document's directory** (Typst resolves image
 * paths relative to the source `.typ` file, so a relative reference is portable
 * and shareable). Falls back to the absolute on-disk path when a relative one
 * can't be expressed — i.e. an untitled tab (no `tab.path` → no file dir), a
 * target on a different Windows drive, or a target outside the workspace that
 * landed in the app-config image cache. In every fallback case the absolute
 * path is still correct (it's where the bytes actually live), just less pretty.
 *
 * Shared by both the raw-image paste flow and the rich-text paste flow so their
 * inserted references stay consistent.
 */
export async function imageSrcForInsert(
  absPath: string,
  tab: { path: string | null },
  ctx: { workspace?: string; filePath?: string },
): Promise<string> {
  const fileDir = await resolveImageDir(ctx, tab);
  if (fileDir) {
    const rel = relativePath(fileDir, absPath);
    if (rel !== null) return rel;
  }
  return absPath;
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
