import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { MonacoVscodeApiConfig } from "monaco-languageclient/vscodeApiWrapper";
import type { LanguageClientConfig } from "monaco-languageclient/lcwrapper";
import type { EditorAppConfig } from "monaco-languageclient/editorApp";
import { invoke } from "@tauri-apps/api/core";

/** LSP status returned by the Rust backend. */
export interface LspStatus {
  running: boolean;
  wsUrl: string;
  available: boolean;
}

/**
 * Get the LSP WebSocket URL from the Rust backend.
 * Returns `null` if LSP is not available.
 */
export async function getLspWsUrl(): Promise<string | null> {
  try {
    const status = await invoke<LspStatus>("get_lsp_status");
    if (status.available && status.running && status.wsUrl) {
      return status.wsUrl;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the `MonacoVscodeApiConfig` for classic mode.
 * Classic mode preserves Monarch tokenizers and custom themes.
 */
export function buildVscodeApiConfig(): MonacoVscodeApiConfig {
  return {
    $type: "classic",
    viewsConfig: { $type: "EditorService" },
  };
}

/**
 * Build the `LanguageClientConfig` for connecting to the Rust-backend
 * WebSocket relay.
 */
export function buildLanguageClientConfig(
  wsUrl: string,
): LanguageClientConfig {
  return {
    languageId: "typst",
    connection: {
      options: {
        $type: "WebSocketUrl",
        url: wsUrl,
        startOptions: {
          onCall: () => console.log("[LSP] connected to tinymist"),
          reportStatus: true,
        },
        stopOptions: {
          onCall: () => console.log("[LSP] disconnected from tinymist"),
          reportStatus: true,
        },
      },
    },
    clientOptions: {
      documentSelector: [{ language: "typst" }],
    },
  };
}

/**
 * Build the `EditorAppConfig` with the Typst language definition
 * (Monarch tokenizer + theme).
 */
export function buildEditorAppConfig(
  tabId: string,
  content: string,
): EditorAppConfig {
  const uri = `inmemory://typst-studio/${tabId}.typ`;

  return {
    codeResources: {
      modified: {
        text: content,
        uri,
        enforceLanguageId: "typst",
      },
    },
    languageDef: {
      languageExtensionConfig: {
        id: "typst",
        extensions: [".typ", ".typst"],
        aliases: ["Typst", "typst"],
      },
      monarchLanguage: buildMonarchLanguage(),
      theme: {
        name: "typst-light",
        data: buildThemeData(),
      },
    },
    editorOptions: {
      fontSize: 13,
      fontFamily:
        '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      wordWrap: "on",
      renderWhitespace: "selection",
    },
  };
}

/** The Monarch tokenizer definition for Typst. */
function buildMonarchLanguage(): Monaco.languages.IMonarchLanguage {
  return {
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
  } as Monaco.languages.IMonarchLanguage;
}

/** The theme data for the Typst light theme. */
function buildThemeData(): Monaco.editor.IStandaloneThemeData {
  return {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "931868", fontStyle: "italic" },
      { token: "keyword.heading", foreground: "0066cc" },
      { token: "type.identifier", foreground: "7a4400" },
      { token: "number", foreground: "1d1d1f" },
      { token: "string", foreground: "065d2c" },
      { token: "comment", foreground: "7a7a7a", fontStyle: "italic" },
      { token: "operator", foreground: "1d1d1f" },
      { token: "strong", foreground: "1d1d1f", fontStyle: "bold" },
      { token: "emphasis", foreground: "1d1d1f", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#ffffff",
    },
  };
}
