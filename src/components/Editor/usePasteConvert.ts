import { useEffect } from "react";
import type { RefObject } from "react";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { Tab } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSetting } from "../../hooks/useSetting";
import { htmlToTypst } from "../../lib/htmlToTypst";
import { escapeTypstStr } from "../../lib/htmlToTypst/escape";
import { expandTemplate } from "../../lib/pathMacros";
import { inferExt } from "../../lib/htmlToTypst/images";
import { sha1Hex } from "./sha1";
import { writeImage, resolveImageDir, ensureAbsolute } from "./imageIo";
import { fetchUrlToFile } from "../../lib/tauri";

export type GetEditor = () => Monaco.editor.IStandaloneCodeEditor | null;

const PLACEHOLDER_RE = /\u0000IMG(\d+)\u0000/g;
const TYPST_MARK = /(^|\n)\s*(= +\S|\*[^*]+\*|_[^_]+_|#image\(|\+ |- )/;

export function usePasteConvert(
  getEditor: GetEditor,
  tabRef: RefObject<Tab>,
): void {
  const [enabled] = useSetting<boolean>("editor.pasteConvertRichText");
  const [imageTemplate] = useSetting<string>("editor.pasteImagePath");
  const [fetchRemote] = useSetting<boolean>("editor.pasteImageFetchRemote");
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  useEffect(() => {
    if (enabled === false) return;
    const handler = async (e: ClipboardEvent) => {
      // ClipboardEvent doesn't declare modifier flags in the DOM lib, but all
      // browsers populate them when the paste was triggered by a keyboard
      // shortcut. Cmd/Ctrl+Shift+V is the native-paste escape hatch.
      const shiftHeld =
        (e as ClipboardEvent & { shiftKey?: boolean }).shiftKey === true;
      if (shiftHeld) return;
      const editor = getEditor();
      if (!editor || !editor.hasTextFocus()) return;
      const html = e.clipboardData?.getData("text/html");
      if (!html) return;
      const plain = e.clipboardData?.getData("text/plain") ?? "";
      if (plain.trim().length > 0 && !looksRich(html, plain)) return;
      if (TYPST_MARK.test(plain)) return;

      const tab = tabRef.current;
      const ctx = {
        workspace: rootPath ?? undefined,
        filePath: tab.path ?? undefined,
        imageTemplate: imageTemplate ?? "${fileDir}/assets/pasted-${hash}.${ext}",
        fetchRemote: fetchRemote !== false,
      };
      let result;
      try {
        result = htmlToTypst(html, ctx);
      } catch (err) {
        console.error("[paste] conversion failed, falling back to native:", err);
        return;
      }
      e.preventDefault();
      // Capture the selection + model identity synchronously before any await:
      // image resolution can take seconds, during which the user may move the
      // cursor or switch tabs. We re-validate BOTH after the await — applying
      // a stale range to a different model would inject the converted paste
      // into the wrong document, and a stale range to the same model would
      // corrupt text inserted before the original selection (cursor drift).
      const startModelUri = editor.getModel()?.uri.toString();
      const finalSrcByIndex: Record<number, string> = {};
      await Promise.all(
        result.pendingImages.map(async (img) => {
          try {
            const finalSrc = await resolveImage(img, ctx, tab);
            finalSrcByIndex[img.index] = finalSrc;
          } catch (err) {
            console.warn(`[paste] image ${img.index} failed:`, err);
            result.warnings.push(`image failed: ${img.src}`);
            finalSrcByIndex[img.index] = img.src;
          }
        }),
      );
      const finalText = result.typst.replace(PLACEHOLDER_RE, (_m, i) => {
        const src = finalSrcByIndex[Number(i)] ?? "";
        return `#image("${escapeTypstStr(src)}")`;
      });
      // Re-validate focus + model identity before applying. The seconds-long
      // image-fetch await above means the user may have switched tabs (model
      // changed) or clicked away from the editor (lost focus). Applying the
      // edit blindly in those cases would either inject into the wrong
      // document or insert at a stale cursor. Bail silently — the user has
      // clearly moved on, and the converted text is dropped (best-effort).
      const liveEditor = getEditor();
      if (!liveEditor || !liveEditor.hasTextFocus()) return;
      const liveUri = liveEditor.getModel()?.uri.toString();
      if (liveUri !== startModelUri) return;
      const sel = liveEditor.getSelection();
      if (!sel) return;
      liveEditor.executeEdits("paste-convert", [{ range: sel, text: finalText }]);
      if (result.warnings.length > 0) {
        console.warn(`[paste] ${result.warnings.length} warnings:`, result.warnings);
      }
    };
    document.addEventListener("paste", handler, true);
    return () => document.removeEventListener("paste", handler, true);
  }, [enabled, imageTemplate, fetchRemote, rootPath, getEditor, tabRef]);
}

function looksRich(html: string, plain: string): boolean {
  const stripped = html.replace(/<[^>]+>/g, "").trim();
  return stripped !== plain.trim();
}

async function resolveImage(
  img: { src: string; index: number },
  ctx: { workspace?: string; filePath?: string; imageTemplate: string; fetchRemote: boolean },
  tab: Tab,
): Promise<string> {
  const ext = inferExt(img.src);
  let bytes: Uint8Array | null = null;
  let hashInput = img.src;
  let isRemote = false;
  if (img.src.startsWith("data:")) {
    bytes = decodeDataUri(img.src);
    hashInput = img.src.slice(img.src.indexOf(",") + 1);
  } else if (/^https?:\/\//i.test(img.src) && ctx.fetchRemote) {
    isRemote = true;
  } else {
    return img.src;
  }
  const hash = await sha1Hex(hashInput + ":" + img.index);
  const fileDir = await resolveImageDir(ctx, tab);
  const rel = expandTemplate(ctx.imageTemplate, {
    workspace: ctx.workspace,
    fileDir,
    fileName: tab.path ? tab.path.split(/[\\/]/).pop()?.replace(/\.typ$/, "") : undefined,
    filePath: tab.path ?? undefined,
    hash,
    ext,
    timestamp: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    index: img.index,
  });
  // Make the expanded path absolute before writing: for an unsaved tab with
  // no workspace, `${fileDir}` stays literal, so `ensureAbsolute` falls back
  // to a `pasted-images/` dir under the app config dir (which the backend's
  // fetch_url_to_file containment check admits). Both the on-disk path and
  // the returned `#image()` src use this absolute value so they always agree.
  const abs = await ensureAbsolute(rel, ctx.workspace);
  if (isRemote) {
    await fetchUrlToFile(img.src, abs);
    return abs;
  }
  if (bytes) {
    await writeImage(abs, bytes);
    return abs;
  }
  return img.src;
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  const data = uri.slice(comma + 1);
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
