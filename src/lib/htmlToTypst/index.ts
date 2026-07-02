import type { ConvertContext, ConvertResult } from "./types";
import { makeWalkCtx } from "./types";
import { wordCleanup } from "./wordCleanup";
import { convertBlocks } from "./blocks";

export function htmlToTypst(html: string, convert: ConvertContext): ConvertResult {
  const cleaned = wordCleanup(html);
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
  const wctx = makeWalkCtx(convert);
  const typst = convertBlocks(doc.body, wctx, 0).trim();
  return {
    typst,
    pendingImages: wctx.pendingImages,
    warnings: wctx.warnings,
  };
}
