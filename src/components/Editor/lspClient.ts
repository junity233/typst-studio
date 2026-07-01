import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { MonacoVscodeApiConfig } from "monaco-languageclient/vscodeApiWrapper";
import type { LanguageClientConfig } from "monaco-languageclient/lcwrapper";
import type { EditorAppConfig } from "monaco-languageclient/editorApp";
import filesServiceOverride, {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import { Uri } from "vscode";

/** Custom URI scheme for in-memory Typst documents. */
export const TYPST_MEM_SCHEME = "typst-mem";

/** Singleton in-memory file system provider for untitled Typst tabs. */
let memProvider: RegisteredFileSystemProvider | null = null;

/** Build the `typst-mem://` URI for a tab. */
export function typstMemUri(tabId: string): string {
  return `${TYPST_MEM_SCHEME}:///${tabId}.typ`;
}

/**
 * Lazily install the in-memory file system overlay.
 * Must run after `buildVscodeApiConfig()` has wired `filesServiceOverride`
 * into the editor services (it is, at module load in MonacoEditor.tsx).
 * Idempotent: safe to call more than once.
 */
function ensureMemProvider(): RegisteredFileSystemProvider {
  if (memProvider === null) {
    // `false` = case-sensitive, `1` = highest overlay priority (front of default).
    memProvider = new RegisteredFileSystemProvider(false);
    registerFileSystemOverlay(1, memProvider);
  }
  return memProvider;
}

/**
 * Register a tab's content as an in-memory file so the VSCode file service
 * can resolve its URI. Returns a cleanup function that unregisters the file.
 *
 * Register ONCE per tab (keyed on `tabId`); the live Monaco model is the
 * source of truth after open, so edits are not written back here.
 */
export function registerTypstMemFile(
  tabId: string,
  content: string,
): () => void {
  const provider = ensureMemProvider();
  const disposable = provider.registerFile(
    new RegisteredMemoryFile(Uri.parse(typstMemUri(tabId)), content),
  );
  return () => disposable.dispose();
}

/**
 * Build the `MonacoVscodeApiConfig` for classic mode.
 * Classic mode preserves Monarch tokenizers and custom themes.
 *
 * Registers a custom file system provider for the `typst-mem://` scheme so
 * in-memory Typst documents can be opened without a real file on disk.
 */
export function buildVscodeApiConfig(): MonacoVscodeApiConfig {
  return {
    $type: "classic",
    viewsConfig: { $type: "EditorService" },
    // `filesServiceOverride()` returns an IEditorOverrideServices object
    // (keyed service-id -> factory); spread to satisfy the literal type.
    serviceOverrides: filesServiceOverride(),
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
    // NOTE: no `restartOptions` here. monaco-languageclient's restart path is
    // effectively dead code (the reader.onClose handler stops the client,
    // flipping isStarted() to false before restartLC's guard runs), so the
    // option would not reconnect. Recovery is handled instead by remounting
    // this component (via a `key` derived from wsUrl in MonacoEditor), which
    // the backend supports because it spawns a fresh tinymist per connection —
    // so each remount runs a legal `initialize` handshake.
    clientOptions: {
      documentSelector: [{ language: "typst" }],
    },
  };
}

/**
 * Build the `EditorAppConfig` with the Typst language definition
 * (Monarch tokenizer + theme). Pure: no side effects.
 *
 * Callers are responsible for registering the tab's in-memory file via
 * `registerTypstMemFile(tabId, content)` in a React effect.
 */
export function buildEditorAppConfig(
  tabId: string,
  content: string,
): EditorAppConfig {
  const uri = typstMemUri(tabId);

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
