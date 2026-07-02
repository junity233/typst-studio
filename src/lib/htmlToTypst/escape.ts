const SPECIAL = /[*_`\[\]$#@~\\]/g;

export function escapeTypst(text: string): string {
  return text.replace(SPECIAL, (ch) => "\\" + ch);
}
