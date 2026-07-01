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

/**
 * Virtual path prefix under which in-memory Typst tabs live. We use the
 * standard `file:` scheme (not a custom scheme) because the
 * `RegisteredFileSystemProvider` overlay only intercepts `file:` requests — a
 * custom scheme like `typst-mem:` has no registered provider and throws
 * `ENOPRO: No file system provider found` when Monaco resolves the model URI.
 * The LSP `documentSelector` matches by language id, not scheme, so this is
 * transparent to tinymist.
 */
export const MEM_ROOT = "/typst-studio-mem";

/** Singleton in-memory file system provider for untitled Typst tabs. */
let memProvider: RegisteredFileSystemProvider | null = null;

/** Build the `file://` URI string for a tab's in-memory document. */
export function typstMemUri(tabId: string): string {
  // Uri.file normalizes to `file:///typst-studio-mem/<id>.typ`. We return the
  // string form so callers (registerTypstMemFile and buildEditorAppConfig) use
  // the exact same canonical URI Monaco will resolve.
  return Uri.file(`${MEM_ROOT}/${tabId}.typ`).toString();
}

/**
 * Install the in-memory file system overlay for virtual `file:` URIs.
 *
 * CRITICAL: must run BEFORE any Monaco editor mounts with a virtual model URI,
 * otherwise the editor's file-service lookup throws
 * `ENOPRO: No file system provider found` during mount and the component
 * crashes. We therefore register it eagerly at module load (see below).
 *
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

// Eagerly register the overlay at module load so it is in place before the
// Monaco editor component mounts and resolves its first virtual URI.
ensureMemProvider();

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
  const uriStr = typstMemUri(tabId);
  const disposable = provider.registerFile(
    new RegisteredMemoryFile(Uri.parse(uriStr), content),
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
 *
 * `rootPath` is the absolute workspace root (or null for a single-file/untitled
 * tab). tinymist is a *project-scoped* LSP: it compiles the document in its own
 * Typst World, and that World needs a root to resolve `#include` / `@preview`
 * packages and scan for `typst.toml`. Without it, completion degrades to a
 * rootless "detached file" mode. We set `initializationOptions.rootPath`
 * (tinymist's authoritative root override) — reliable here because our
 * in-memory documents live under a virtual path (`file:///typst-studio-mem`)
 * that isn't under the real workspace, so tinymist's path-based root discovery
 * would otherwise fail.
 */
export function buildLanguageClientConfig(
  wsUrl: string,
  rootPath: string | null,
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
      // tinymist is project-scoped: it roots its compile World on a project
      // directory to resolve #include / @preview. `initializationOptions.rootPath`
      // is tinymist's authoritative root override (config.rs:510-516) and is the
      // reliable way to set it from monaco-languageclient, whose
      // LanguageClientOptions surface doesn't expose `workspaceFolders`. Must be
      // absolute (relative values are rejected). Null for untitled/no-workspace
      // tabs → tinymist degrades to single-file mode (still functional).
      initializationOptions: {
        ...(rootPath !== null ? { rootPath } : {}),
        // Client-capability flags tinymist checks to enable richer completion UX
        // (trigger-suggest after typing certain tokens, HTML in hover, etc).
        // See tinymist config.rs CONFIG_ITEMS.
        triggerSuggest: true,
        triggerParameterHints: true,
        supportHtmlInMarkdown: true,
      },
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
