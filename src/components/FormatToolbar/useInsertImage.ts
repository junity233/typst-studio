import { readFile } from "@tauri-apps/plugin-fs";
import type { FormatApi } from "./formatActions";
import type { Tab } from "../../store/tabsStore";
import { pickImageFile } from "../../lib/tauri";
import { inferExt } from "../../lib/htmlToTypst/images";
import { escapeTypstStr } from "../../lib/htmlToTypst/escape";
import { expandTemplate } from "../../lib/pathMacros";
import { resolveImageDir, ensureAbsolute, writeImage } from "../Editor/imageIo";

/**
 * The non-edit details the insert-image flow needs to resolve a destination
 * path. Mirrors the slice of {@link ActionContext} the hook consumes — kept as
 * its own type so the hook is testable without standing up the full toolbar
 * context. `tab` is nullable because the toolbar can render with no open
 * document; the flow simply bails in that case.
 */
export interface InsertImageContext {
  tab: Tab | null;
  workspace: string | null;
  insertImagePathTemplate: string | undefined;
}

/**
 * Returns an async callback that opens the native image picker, copies the
 * chosen file into the configured assets location, and inserts `#image("…")`
 * at the cursor. No-ops on cancel or when there's no tab. Mirrors the
 * paste-image flow (`usePasteConvert.ts` `resolveImage`) — reuses imageIo +
 * pathMacros + `escapeTypstStr` so the path math stays in one place.
 *
 * Why a hook (not a plain function): it is called at the top level of
 * FormatToolbar and its returned callback is threaded into {@link
 * ActionContext.insertImage}, so each render's closure captures the latest
 * `tab` / `workspace` / template. The callback itself is imperative — no React
 * state, no effects.
 *
 * The inserted path is the absolute on-disk path (matches the existing paste
 * flow per spec §5.4; a relative-path mode is a documented follow-up).
 */
export function useInsertImage(
  ctx: InsertImageContext,
): (api: FormatApi) => Promise<void> {
  return async (api: FormatApi) => {
    try {
      const tab = ctx.tab;
      if (tab === null) return;
      const picked = await pickImageFile();
      if (picked === null) return; // user cancelled
      const bytes = await readFile(picked);
      const ext = inferExt(picked);
      const fileDir = await resolveImageDir(
        { workspace: ctx.workspace ?? undefined, filePath: tab.path ?? undefined },
        tab,
      );
      // Derive the basename from the picked path — mirrors how usePasteConvert
      // derives fileName from tab.path (split on either separator so this works
      // on both Windows `\` and POSIX `/` paths).
      const fileName = picked.split(/[\\/]/).pop() ?? "image";
      const template =
        ctx.insertImagePathTemplate ?? "${fileDir}/assets/${fileName}";
      const rel = expandTemplate(template, {
        workspace: ctx.workspace ?? undefined,
        fileDir,
        fileName,
        filePath: tab.path ?? undefined,
        ext,
        timestamp: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        // ${index} is always 0 (single image per insert) and ${hash} is
        // unsupported here (unlike paste, which dedups via sha1). The default
        // template uses ${fileName} for uniqueness instead.
        index: 0,
      });
      const abs = await ensureAbsolute(rel, ctx.workspace ?? undefined);
      await writeImage(abs, bytes);
      api.replaceSelection('#image("' + escapeTypstStr(abs) + '")');
    } catch (err) {
      // No toast/notification system exists yet (only the heavy ConfirmDialog).
      // For v1, log clearly so the failure isn't silent; a future toast should
      // surface this to the user. The flow aborts before the editor insert on
      // any error (writeImage rejects, picker throws, etc.), so we never leave
      // a half-applied edit.
      console.error("[FormatToolbar] insert image failed:", err);
    }
  };
}
