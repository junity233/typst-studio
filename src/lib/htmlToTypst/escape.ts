// `/` MUST be escaped: unescaped, any `https://` URL in pasted text becomes a
// Typst line comment that silently swallows the rest of the line (and `/*`
// opens a block comment). `<`/`>` are escaped so `<label>`-shaped text can't be
// mistaken for Typst content syntax.
const SPECIAL = /[*_`\[\]$#@~\\\/<>]/g;

export function escapeTypst(text: string): string {
  return text.replace(SPECIAL, (ch) => "\\" + ch);
}

/** Escape a Typst string-literal value: only `\` and `"` need escaping. */
export function escapeTypstStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
