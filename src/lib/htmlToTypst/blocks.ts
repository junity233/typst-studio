import type { WalkCtx } from "./types";
import { convertInline } from "./inline";
import { convertTable } from "./tables";
import { escapeTypst } from "./escape";

const MAX_LIST_DEPTH = 6;

/**
 * Escape a leading character that Typst would otherwise re-interpret as a
 * block marker: `=` (heading), `+` / `-` (list), `/` (term list / emphasis
 * edge). Only the FIRST non-whitespace char matters, and only these specific
 * triggers — inline markup is already handled by `escapeTypst`. `\=` renders
 * as a literal `=` in Typst.
 */
function escapeLeadingBlockMarker(line: string): string {
  const m = line.match(/^(\s*)([=+\-/])/);
  if (!m) return line;
  return `${m[1]}\\${m[2]}${line.slice(m[0].length)}`;
}

export function convertBlocks(node: Node, wctx: WalkCtx, depth: number): string {
  const parts: string[] = [];
  node.childNodes.forEach((child) => {
    const block = blockNode(child, wctx, depth);
    if (block.length > 0) parts.push(block);
  });
  return parts.join("\n\n");
}

function blockNode(node: Node, wctx: WalkCtx, depth: number): string {
  if (node.nodeType === 3 /* TEXT */) {
    const t = (node.textContent ?? "").trim();
    if (!t.length) return "";
    // A top-level text node becomes its own block line; escape a leading
    // marker char so it isn't re-parsed as a heading/list by Typst.
    return escapeLeadingBlockMarker(escapeTypst(node.textContent ?? "").trim());
  }
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]);
      return "=".repeat(level) + " " + convertInline(el, wctx).trim();
    }
    case "p": {
      // Escape a leading `=`, `+`, `-`, or `/` so the paragraph isn't
      // re-interpreted as a Typst heading / list-item / numberless-list
      // marker. (escapeTypst only covers inline markup chars; block-leading
      // triggers need a block-level guard.) `\=` etc. render as literal text.
      return escapeLeadingBlockMarker(convertInline(el, wctx).trim());
    }
    case "div": {
      return convertBlocks(el, wctx, depth).trim();
    }
    case "ul":
    case "ol":
      return convertList(el, wctx, depth, tag === "ol");
    case "blockquote": {
      const inner = convertBlocks(el, wctx, depth).trim();
      return `#quote[${inner}]`;
    }
    case "pre":
      return convertPre(el);
    case "hr":
      return "#line(length: 100%)";
    case "table":
      return convertTable(el, wctx);
    default:
      return convertInline(el, wctx);
  }
}

function convertList(el: Element, wctx: WalkCtx, depth: number, ordered: boolean): string {
  const marker = ordered ? "+" : "-";
  const indent = "  ".repeat(Math.min(depth, MAX_LIST_DEPTH));
  if (depth >= MAX_LIST_DEPTH) {
    wctx.warnings.push("list nesting truncated at depth " + MAX_LIST_DEPTH);
  }
  const lines: string[] = [];
  el.querySelectorAll(":scope > li").forEach((li) => {
    const clone = li.cloneNode(true) as Element;
    clone.querySelectorAll(":scope > ul, :scope > ol").forEach((n) => n.remove());
    const inline = convertInline(clone, wctx).trim();
    lines.push(`${indent}${marker} ${inline}`);
    li.querySelectorAll(":scope > ul, :scope > ol").forEach((sub) => {
      lines.push(convertList(sub, wctx, depth + 1, sub.tagName.toLowerCase() === "ol"));
    });
  });
  return lines.join("\n");
}

function convertPre(el: Element): string {
  const code = el.querySelector("code");
  let lang = "";
  if (code) {
    const cls = code.getAttribute("class") ?? "";
    const m = cls.match(/language-([a-z0-9]+)/i);
    if (m) lang = m[1];
  }
  const text = (code ?? el).textContent ?? "";
  return "```" + lang + "\n" + text.replace(/\n$/, "") + "\n```";
}
