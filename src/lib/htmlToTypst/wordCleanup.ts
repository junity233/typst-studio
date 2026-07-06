const WORD_ENTITIES: [RegExp, string][] = [
  [/\u201c/g, '"'],
  [/\u201d/g, '"'],
  [/\u2018/g, "'"],
  [/\u2019/g, "'"],
  [/\u00a0/g, " "],
  [/\u2026/g, "..."],
];

export function isWordHtml(html: string): boolean {
  return (
    /mso-/i.test(html) ||
    (/name\s*=\s*["']?ProgId/i.test(html) && /Word\.Document/i.test(html)) ||
    /<\/?(?:o:p|w:\w|v:\w|m:\w|st1:\w)/i.test(html) ||
    /[\u201c\u201d\u2018\u2019\u00a0\u2026]/.test(html)
  );
}

export function wordCleanup(html: string): string {
  if (!isWordHtml(html)) return html;
  let out = html;
  // Bound the `[^]*?` scan so a crafted/truncated conditional-block opener
  // (no matching `endif` terminator) can't force a multi-second backtrack
  // across a large paste. 4000 chars is generous for any real Word conditional.
  out = out.replace(/<!--\[if\s[^]{0,4000}?\]>\s*<!\[endif\]-->/gi, "");
  out = out.replace(/<!\[if\s[^]{0,4000}?\]>/gi, "");
  out = out.replace(/<!\[endif\]>/gi, "");
  out = out.replace(/<\/?(o:p|w:[\w]+|v:[\w]+|m:[\w]+|st1:[\w]+)[^>]*>/gi, "");
  out = out.replace(/\s*style\s*=\s*"([^"]*)"/gi, (_m, style: string) => {
    const cleaned = style
      .split(";")
      .filter((p: string) => !/^\s*mso-/i.test(p))
      .join(";");
    return cleaned.trim().length > 0 ? ` style="${cleaned}"` : "";
  });
  out = out.replace(/\s*class\s*=\s*"[^"]*Mso[^"]*"/gi, "");
  for (const [re, rep] of WORD_ENTITIES) out = out.replace(re, rep);
  return out;
}
