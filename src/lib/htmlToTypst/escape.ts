const SPECIAL = /[*_`\[\]$#@~\\]/g;

export function escapeTypst(text: string): string {
  return text.replace(SPECIAL, (ch) => "\\" + ch);
}

/** Escape a Typst string-literal value: only `\` and `"` need escaping. */
export function escapeTypstStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
