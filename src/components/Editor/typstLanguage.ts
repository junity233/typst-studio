import * as monacoNS from "monaco-editor";
import type * as Monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

/**
 * One-time Monaco + typst language setup:
 *  - wires the bundled monaco-editor (offline under Tauri, not the CDN default)
 *  - configures the editor web worker via Vite's `?worker` import
 *  - registers the `typst` language id, Monarch tokenizer, and config
 *
 * A TextMate grammar (monaco-textmate) is intentionally NOT used: wiring TM
 * needs oniguruma WASM + a grammar JSON + a registry, which is heavy and
 * brittle under Vite/Tauri. Monarch gives good-enough highlighting for the MVP
 * without the extra moving parts.
 */
export function setupMonaco(): void {
  if (setupDone) return;
  setupDone = true;

  // Editor web worker. `getWorker` signature is (workerId, label); typst has no
  // language-specific worker, so always return the base editor worker.
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };

  // Use the npm-bundled monaco namespace instead of fetching from a CDN.
  loader.config({ monaco: monacoNS as unknown as typeof Monaco });
}

/** Register the `typst` language (id, config, Monarch tokenizer) with monaco. */
export function registerTypstLanguage(monaco: typeof Monaco): void {
  if (languageRegistered) return;
  languageRegistered = true;

  monaco.languages.register({ id: "typst", extensions: [".typ", ".typst"] });

  monaco.languages.setMonarchTokensProvider("typst", {
    defaultToken: "",
    tokenPostfix: ".typst",
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.square" },
      { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
    tokenizer: {
      root: [
        [/^(=+)\s.*$/, "keyword.heading"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
        [
          /#(set|let|if|else|for|while|import|include|return|show|context)\b/,
          "keyword",
        ],
        [/#([a-zA-Z_][\w-]*)/, "type.identifier"],
        [/"/, "string", "@string"],
        [/\b\d+(\.\d+)?(px|pt|em|cm|mm|in|%)?\b/, "number"],
        [/[+\-*/=<>!&|]/, "operator"],
        [/\*[^*]+\*/, "strong"],
        [/_[^_]+_/, "emphasis"],
        { include: "@whitespace" },
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      whitespace: [[/\s+/, "white"]],
    },
  } as Monaco.languages.IMonarchLanguage);

  monaco.languages.setLanguageConfiguration("typst", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "/*", close: " */", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });
}

let setupDone = false;
let languageRegistered = false;
