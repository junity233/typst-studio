import { join, dirname, isAbsolute, tempDir } from "@tauri-apps/api/path";
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

/** Ensure a template-expanded path is absolute; fall back to tempDir. */
export async function ensureAbsolute(
  resolved: string,
  workspace?: string,
): Promise<string> {
  if (await isAbsolute(resolved)) return resolved;
  if (workspace) return join(workspace, resolved);
  return join(await tempDir(), resolved);
}
