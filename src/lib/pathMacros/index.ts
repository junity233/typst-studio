import type { ExpandOptions, MacroContext } from "./types";

const MACRO_RE = /\$(\$)?\{([a-zA-Z_][a-zA-Z0-9_]*)([?:][^}]*)?\}/g;

export function expandTemplate(
  template: string,
  ctx: MacroContext,
  options?: ExpandOptions,
): string {
  const mode = options?.unknown ?? "keep";
  return template.replace(MACRO_RE, (whole, dollar, name: string, modifier: string) => {
    if (dollar === "$") return `\${${name}${modifier ?? ""}}`;
    const val = ctx[name as keyof MacroContext];
    if (val !== undefined) return String(val);
    if (modifier !== undefined) {
      if (modifier.startsWith(":")) return modifier.slice(1);
      if (modifier.startsWith("?")) {
        throw new Error(`missing required macro: ${name}`);
      }
    }
    if (mode === "drop") return "";
    if (mode === "throw") throw new Error(`unknown macro: ${name}`);
    return whole;
  });
}
