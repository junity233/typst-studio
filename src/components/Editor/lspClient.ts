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
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";
import { buildLanguageClientOptions } from "./appLanguageClient";

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
 * Build the `MonacoVscodeApiConfig` for extended mode.
 *
 * Extended mode is mandatory for TextMate + semantic-token highlighting:
 * `configureHighlightingServices()` in monaco-languageclient only dynamic-
 * imports the textmate/theme/languages service overrides when `$type ===
 * "extended"`, and the classic branch loads just a no-op monarch override.
 *
 * We register tinymist's manifest slice (grammars + semanticTokenScopes) as a
 * web extension. `semanticTokenScopes` is the critical bit — it's how tinymist's
 * LSP `textDocument/semanticTokens` output gets mapped to TextMate scopes →
 * theme colors. Without it, semantic tokens arrive but render unstyled.
 *
 * Grammar JSONs are provided inline via `filesOrContents` (encoded as data URLs
 * by the wrapper) so the TextMate service can fetch them from the extension
 * registry without a network call.
 */
export function buildVscodeApiConfig(): MonacoVscodeApiConfig {
  return {
    $type: "extended",
    viewsConfig: { $type: "EditorService" },
    // filesServiceOverride is still needed for our in-memory `file://` overlay
    // (the virtual Typst tab URIs). TextMate/theme/languages overrides are
    // auto-loaded by the wrapper in extended mode.
    serviceOverrides: filesServiceOverride(),
    // Force-on semantic highlighting regardless of any user config; tinymist's
    // grammar is wired for it, and the configurationDefaults in the manifest
    // also enable it, but this is the server-agnostic guarantee.
    advanced: { enforceSemanticHighlighting: true },
    // Wire Monaco's worker URLs (editorWorkerService / TextMateWorker /
    // extensionHostWorkerMain). Without this, MonacoEnvironment.getWorkerUrl
    // is undefined and Monaco falls back to running worker code on the main
    // thread ("Could not create web worker(s)... Falling back to loading web
    // worker code in main thread, which might cause UI freezes").
    monacoWorkerFactory: configureDefaultWorkerFactory,
    userConfiguration: {
      // NOTE: In monaco-vscode-api v25, the workbench theme service never
      // actually loads this theme from the bundled extension. The real theme
      // + token CSS is applied manually by typstHighlighting.ts. This entry
      // is kept for forward compatibility (v34+ loads it properly).
      json: JSON.stringify({
        "workbench.colorTheme": "Default Light Modern",
      }),
    },
    // NOTE: the `extensions` field (tinymist manifest with contributes.grammars
    // + semanticTokenScopes) is intentionally omitted. In v25 the extension
    // host doesn't process contributes from programmatically registered
    // extensions — the grammar never reaches the TextMate service. Instead,
    // highlighting is registered directly via typstHighlighting.ts. When v34
    // is published to npm, restore the `extensions` field and delete
    // typstHighlighting.ts.
  };
}

/**
 * Build the `LanguageClientConfig` for connecting to the Rust-backend
 * WebSocket relay.
 *
 * The §7-compliant `clientOptions` (documentSelector for both `file`/`untitled`
 * schemes per §9.2, workspace rooting via `workspaceFolder` per §7.1/§7.2, the
 * three workspace-independent trigger flags per §7.3, and the §7.3/§21 #13
 * guarantee of NO global `rootPath`/`rootUri` override) are built by the SHARED
 * [`buildLanguageClientOptions`](./appLanguageClient.buildLanguageClientOptions)
 * helper. That helper is the single source of truth for the §7 options shape —
 * this wrapper path (the live `@typefox/monaco-editor-react` client) and the
 * `appLanguageClient` singleton path both emit identical options through it,
 * so the §7.3 rootPath tripwire test covers both for free.
 *
 * NOTE: This config drives the EXISTING wrapper-based client
 * (`@typefox/monaco-editor-react`'s `languageClientConfig` prop). Task 4 also
 * introduces `appLanguageClient.ts`, a standalone singleton that bypasses the
 * wrapper; the two coexist briefly until a later task rewires MonacoEditor to
 * use the singleton. Both paths emit the same §7-compliant options shape.
 */
export function buildLanguageClientConfig(
  wsUrl: string,
  workspaceRootPath: string | null,
  workspaceName: string | null,
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
    // §7.1/§7.2/§7.3 options sourced from the shared helper (single source of
    // truth) — see appLanguageClient.buildLanguageClientOptions.
    clientOptions: buildLanguageClientOptions(
      workspaceRootPath,
      workspaceName,
    ),
  };
}

/**
 * Build the `EditorAppConfig` with the Typst language definition
 * (Monarch tokenizer + theme). Pure: no side effects.
 *
 * Callers are responsible for registering the tab's in-memory file via
 * `registerTypstMemFile(tabId, content)` in a React effect.
 *
 * `editorOptions` (optional) is merged OVER the built-in defaults so callers
 * (e.g. settings-driven option overrides) can adjust the editor without losing
 * the baseline configuration. The wrapper live-applies these on change via
 * `editor.updateOptions`.
 */
export function buildEditorAppConfig(
  tabId: string,
  content: string,
  editorOptions?: Monaco.editor.IStandaloneEditorConstructionOptions,
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
      // Reclaim editable width: drop the glyph margin and slim the line-number
      // gutter. Typst needs neither breakpoints nor a wide number column.
      glyphMargin: false,
      lineNumbersMinChars: 3,
      folding: false,
      // Disable CodeLens: tinymist publishes a "1@Export PDF" clickable lens at
      // the top of the document. The app exposes export through the native menu
      // instead, so hide the lens.
      codeLens: false,
      // Tighten the vertical air around the text so the editor reads edge-to-edge
      // within its pane instead of floating in wide whitespace.
      padding: { top: 6, bottom: 6 },
      ...editorOptions,
    },
  };
}
