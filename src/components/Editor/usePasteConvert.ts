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
import { sha1Hex, sha1HexBytes } from "./sha1";
import { writeImage, resolveImageDir, ensureAbsolute, imageSrcForInsert } from "./imageIo";
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
      const tab = tabRef.current;
      const ctx = {
        workspace: rootPath ?? undefined,
        filePath: tab.path ?? undefined,
        imageTemplate: imageTemplate ?? "${fileDir}/assets/pasted-${hash}.${ext}",
        fetchRemote: fetchRemote !== false,
      };

      // Raw-image paste (screenshot, copied image file): the clipboard carries
      // image file items but no HTML, so the rich-text conversion below never
      // runs. Handle it up-front — save each to the configured folder and drop
      // one #image("…") per item at the caret. The File handles are captured
      // synchronously here (before any await) because clipboard items can be
      // invalidated once the handler yields; a File itself stays readable.
      if (!html) {
        const rawImages = collectClipboardImages(e.clipboardData);
        if (rawImages.length === 0) return; // no HTML, no image → native paste
        e.preventDefault();
        const startModelUri = editor.getModel()?.uri.toString();
        const srcs = await Promise.all(
          rawImages.map((file, index) =>
            resolveRawImage(file, ctx, tab, index).catch((err) => {
              console.warn("[paste] raw image failed:", err);
              return null;
            }),
          ),
        );
        const finalText = srcs
          .filter((s): s is string => s !== null)
          .map((s) => `#image("${escapeTypstStr(s)}")`)
          .join("\n");
        if (finalText.length === 0) return; // every image failed
        // Re-validate focus + model identity before applying. Image writes can
        // take time, during which the user may switch tabs (model changed) or
        // click away from the editor. Bail silently rather than inject into the
        // wrong document or at a stale cursor (same rationale as rich-text path).
        const liveEditor = getEditor();
        if (!liveEditor || !liveEditor.hasTextFocus()) return;
        const liveUri = liveEditor.getModel()?.uri.toString();
        if (liveUri !== startModelUri) return;
        const sel = liveEditor.getSelection();
        if (!sel) return;
        liveEditor.executeEdits("paste-raw-image", [{ range: sel, text: finalText }]);
        return;
      }

      const plain = e.clipboardData?.getData("text/plain") ?? "";
      if (plain.trim().length > 0 && !looksRich(html, plain)) return;
      if (TYPST_MARK.test(plain)) return;
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
  } else if (bytes) {
    await writeImage(abs, bytes);
  } else {
    return img.src;
  }
  // Prefer a path relative to the source document so #image() stays portable
  // (Typst resolves image paths relative to the source .typ file). Falls back
  // to the absolute path when a relative one can't be expressed (untitled tab,
  // cross-drive, app-config cache). Shared with the raw-image paste path.
  return await imageSrcForInsert(abs, tab, ctx);
}

/**
 * Pull image files off a paste's {@link DataTransfer}. Screenshots and "copy
 * image" land here as `kind: "file"` items with an `image/*` MIME type and NO
 * `text/html` payload (which is why the rich-text path never sees them). Must
 * be called synchronously during the event — `DataTransferItem` access is
 * invalidated once the handler yields — but the returned {@link File}s stay
 * readable across awaits.
 */
function collectClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  const items = data.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

/**
 * Resolve a raw pasted image (screenshot / copied file) to the `#image("…")`
 * source string, mirroring {@link resolveImage}'s contract for the rich-text
 * path: expand the template, write the bytes to disk, and return a
 * document-relative path. The difference is the bytes come straight off the
 * clipboard (no data-URI decoding, no remote fetch), and the dedup hash is over
 * the raw image bytes rather than a base64 string.
 */
async function resolveRawImage(
  file: File,
  ctx: { workspace?: string; filePath?: string; imageTemplate: string; fetchRemote: boolean },
  tab: Tab,
  index: number,
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha1HexBytes(bytes);
  // Synthesize a `data:<mime>;` prefix so {@link inferExt} (which keys on
  // `^data:image/<sub>;`) maps the MIME type to an extension without a
  // separate MIME→ext table. `image/jpeg` → jpg, `image/svg+xml` → svg, etc.
  const ext = inferExt(`data:${file.type};`);
  const fileDir = await resolveImageDir(ctx, tab);
  const rel = expandTemplate(ctx.imageTemplate, {
    workspace: ctx.workspace,
    fileDir,
    fileName: tab.path ? tab.path.split(/[\\/]/).pop()?.replace(/\.typ$/, "") : undefined,
    filePath: tab.path ?? undefined,
    hash,
    ext,
    timestamp: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    index,
  });
  const abs = await ensureAbsolute(rel, ctx.workspace);
  await writeImage(abs, bytes);
  return await imageSrcForInsert(abs, tab, ctx);
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  const data = uri.slice(comma + 1);
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
