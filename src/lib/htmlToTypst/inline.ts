import type { WalkCtx } from "./types";
import { escapeTypst, escapeTypstStr } from "./escape";
import { collectImage } from "./images";

export function convertInline(node: Node, wctx: WalkCtx): string {
  let out = "";
  node.childNodes.forEach((child) => {
    out += inlineNode(child, wctx);
  });
  return out;
}

function inlineNode(node: Node, wctx: WalkCtx): string {
  if (node.nodeType === 3 /* TEXT */) {
    return escapeTypst(node.textContent ?? "");
  }
  if (node.nodeType !== 1 /* ELEMENT */) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const inner = () => convertInline(el, wctx);

  switch (tag) {
    case "b":
    case "strong":
      return `*${inner()}*`;
    case "i":
    case "em":
      return `_${inner()}_`;
    case "code": {
      // Raw code spans in Typst are delimited by backticks and terminate at the
      // first run of backticks at least as long as the opener. Emitting raw
      // `textContent` between single backticks would let an embedded longer
      // run (e.g. ``` inside pasted code) close the span early and re-inject
      // the trailing text as markup. Pick a fence strictly longer than the
      // longest backtick run in the content (the common Markdown/Typst idiom).
      const text = el.textContent ?? "";
      const runs = text.match(/`+/g);
      const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
      const fence = "`".repeat(longest + 1);
      return fence + text + fence;
    }
    case "del":
    case "s":
    case "strike":
      return `#strike[${inner()}]`;
    case "u":
      return `#underline[${inner()}]`;
    case "mark":
      return `#highlight[${inner()}]`;
    case "sub":
      return `#sub ${inner()}`;
    case "sup":
      return `#super ${inner()}`;
    case "br":
      return "\\\n";
    case "img":
      return collectImage(el as HTMLImageElement, wctx);
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text = inner();
      if (!href) return text;
      if (text === href) return `#link("${escapeTypstStr(href)}")`;
      return `#link("${escapeTypstStr(href)}")[${text}]`;
    }
    case "span": {
      const style = el.getAttribute("style") ?? "";
      let s = inner();
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) s = `*${s}*`;
      if (/font-style\s*:\s*italic/i.test(style)) s = `_${s}_`;
      if (/text-decoration[^;]*line-through/i.test(style)) s = `#strike[${s}]`;
      if (/text-decoration[^;]*underline/i.test(style)) s = `#underline[${s}]`;
      if (/vertical-align\s*:\s*super/i.test(style)) s = `#super ${s}`;
      if (/vertical-align\s*:\s*sub/i.test(style)) s = `#sub ${s}`;
      return s;
    }
    default:
      return inner();
  }
}
