import type { WalkCtx } from "./types";

const IMG_PLACEHOLDER = (i: number) => `\u0000IMG${i}\u0000`;

export function inferExt(src: string): string {
  const m = src.match(/^data:image\/([a-z+]+);/i);
  if (m) {
    const sub = m[1].toLowerCase();
    if (sub === "jpeg") return "jpg";
    if (sub === "svg+xml") return "svg";
    return sub;
  }
  const ext = src.split("?")[0].split("#")[0].match(/\.([a-z0-9]+)$/i);
  if (ext) {
    const sub = ext[1].toLowerCase();
    if (sub === "jpeg") return "jpg";
    return sub;
  }
  return "png";
}

export function collectImage(img: HTMLImageElement, wctx: WalkCtx): string {
  const index = wctx.nextImageIndex++;
  const placeholder = IMG_PLACEHOLDER(index);
  wctx.pendingImages.push({
    placeholder,
    src: img.getAttribute("src") ?? "",
    alt: img.getAttribute("alt") ?? undefined,
    index,
  });
  return placeholder;
}
