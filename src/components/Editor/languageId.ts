import type { DocumentKind, DocumentOrigin } from "../../lib/types";

/**
 * File-extension → Monaco language-id map for the editable non-Typst kinds.
 *
 * Covers the extensions Monaco ships built-in grammars for (via the
 * `@codingame/monaco-vscode-*` overrides the app bundles). Extensions not
 * listed here fall back to `"plaintext"` in [`languageIdFor`], which keeps
 * unknown files editable as plain text. The map is intentionally hand-curated
 * (rather than querying `monaco.languages.getLanguages()`) so the result is
 * deterministic, import-cycle-free, and works under jsdom where Monaco isn't
 * loaded.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  // web/markup
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  // javascript / typescript
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascript", ts: "typescript", tsx: "typescript",
  mts: "typescript", cts: "typescript",
  // data / config
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", xml: "xml", csv: "plaintext",
  // shell / scripting
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
  bat: "bat", cmd: "bat",
  // systems
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", rs: "rust",
  go: "go", java: "java", kt: "kotlin", swift: "swift",
  // dynamic
  py: "python", rb: "ruby", php: "php", lua: "lua", pl: "perl",
  // jvm / functional
  scala: "scala", clj: "clojure", hs: "haskell", elixir: "elixir",
  // query / db
  sql: "sql", graphql: "graphql", gql: "graphql",
  // docs
  tex: "latex", bib: "bibtex",
  // logs
  log: "plaintext",
};

/**
 * Map a document's path + kind to the Monaco language id for its model.
 *
 * - `typst` → `"typst"` (the registered Typst language; unchanged behavior).
 * - `markdown` → `"markdown"` (Monaco ships a markdown grammar).
 * - `text` → looked up in [`EXTENSION_LANGUAGE`] by the file extension, falling
 *   back to `"plaintext"` when the extension is unknown. This gives free syntax
 *   highlighting for json/ts/py/css/... without shipping grammars, while
 *   keeping unknown files editable as plain text.
 * - binary kinds (`image`/`pdf`) never reach Monaco (no editor is rendered),
 *   so they map to `"plaintext"` defensively — the value is unused.
 *
 * Lives in its own module (not `documentUri.ts`) so importing it doesn't drag
 * in the `vscode`/Monaco namespace — that keeps the pure planning helper
 * (`editorModelSync.ts`) and its unit tests free of Monaco workers/CSS.
 */
export function languageIdFor(
  originPath: string | null,
  kind: DocumentKind,
): string {
  if (kind === "typst") return "typst";
  if (kind === "markdown") return "markdown";
  if (originPath !== null) {
    const ext = originPath.split(".").pop()?.toLowerCase();
    if (ext !== undefined && ext !== "" && ext in EXTENSION_LANGUAGE) {
      return EXTENSION_LANGUAGE[ext];
    }
  }
  return "plaintext";
}

/**
 * The slice of a document that [`languageIdForDocument`] reads. Kept structural
 * (rather than importing the store's `Document`) so this pure module stays free
 * of the store's transitive imports — matching the "import-cycle-free" property
 * documented at the top of the file.
 */
interface DocumentLanguageShape {
  /** Content kind; defaults to `"typst"` when unset (legacy fixtures). */
  kind?: DocumentKind;
  origin: DocumentOrigin;
}

/**
 * Derive the Monaco language id for an open document.
 *
 * Single source of truth for the three-way decision shared by the model-sync
 * planner ([`computeModelSyncPlan`](./editorModelSync.ts)) and the editor's
 * self-sufficient open ([`MonacoEditor`](./MonacoEditor.tsx)):
 * - `kind` defaults to `"typst"` (legacy fixtures / unset field).
 * - binary kinds (`image`/`pdf`) never reach Monaco, so they map to `"plaintext"`
 *   defensively (the value is unused — no editor renders for them).
 * - otherwise defer to [`languageIdFor`] keyed on the document's origin path
 *   (`null` for untitled docs, which have no path to derive an extension from).
 */
export function languageIdForDocument(
  doc: DocumentLanguageShape,
): string {
  const kind = doc.kind ?? "typst";
  if (kind === "image" || kind === "pdf") return "plaintext";
  const originPath =
    doc.origin.kind === "untitled" ? null : doc.origin.path;
  return languageIdFor(originPath, kind);
}
