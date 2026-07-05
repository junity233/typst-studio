import type { MonacoVscodeApiConfig } from "monaco-languageclient/vscodeApiWrapper";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import type { LanguageClientConfig } from "monaco-languageclient/lcwrapper";
import filesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";
import { buildLanguageClientOptions } from "./appLanguageClient";

/**
 * Virtual path prefix under which in-memory (untitled) Typst docs live in the
 * fallback URI scheme. This is KEPT ONLY as a string-equal anchor for the
 * drift-tripwire test in
 * [`documentUri.test.ts`](./__tests__/documentUri.test.ts), which parses this
 * literal from source to assert it stays in sync with
 * [`APP_PRIVATE_VIRTUAL_ROOT`](./documentUri.ts). The production single source
 * of truth is `documentUri.ts`'s `APP_PRIVATE_VIRTUAL_ROOT`; once a later task
 * collapses the two, delete this and relax the tripwire.
 *
 * History: in the pre-refactor design EVERY open doc — disk or untitled — lived
 * under this prefix as a virtual `file:` URI (`file:///typst-studio-mem/<id>.typ`)
 * resolved through a `RegisteredFileSystemProvider` overlay. Phase A replaced
 * that with real `file:` URIs for disk docs and `untitled:` (or the fallback
 * `file:///<APP_PRIVATE_VIRTUAL_ROOT>/<id>.typ`) for untitled docs, driven by
 * [`monacoModelRegistry`](./monacoModelRegistry.ts) via
 * [`originToUri`](./documentUri.ts). The overlay, the per-tab file
 * registration, and the per-tab `editorAppConfig.codeResources` URI were all
 * removed (spec §17 移除 list); this constant lingers only for the tripwire.
 */
export const MEM_ROOT = "/typst-studio-mem";

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
    // filesServiceOverride is required for the VS Code file/textdocument/
    // explorer services that the extended-mode overrides (TextMate, languages,
    // themes) depend on. (Pre-Phase-A it also hosted our in-memory `file://`
    // overlay for virtual tab URIs; that overlay is gone — models now come from
    // monacoModelRegistry with URIs from originToUri.)
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
 * Initialize the monaco-vscode-api services EXACTLY ONCE, before the
 * `@typefox/monaco-editor-react` wrapper component mounts.
 *
 * WHY: the wrapper has TWO effects (keyed on `editorAppConfig` and
 * `languageClientConfig`) that BOTH call `performGlobalInit`, which news a
 * `MonacoVscodeApiWrapper` and calls `start()`. When both effects fire in the
 * same commit, the second `start()` races the first's async services-init and
 * panics with "Services are already initialized" (Monaco's services can only
 * be initialized once per process). The wrapper's `vscodeApiInitialising`
 * guard is meant to prevent this, but `start()` only sets it AFTER several
 * awaits, leaving a window the second effect falls into.
 *
 * FIX: pre-initialize the services ourselves here, so by the time the wrapper
 * mounts, `envEnhanced.vscodeApiInitialised === true`. The wrapper's
 * `performGlobalInit` then takes its `else if (initialised === true)` branch
 * (index.js:117) — it neither news a wrapper nor calls `start()`, so no race
 * is possible regardless of how many of its effects fire.
 *
 * Idempotent + memoized: the singleton wrapper is constructed and started
 * once; the returned promise is shared across all callers.
 */
let vscodeApiInitPromise: Promise<void> | null = null;

export function ensureVscodeApiInitialized(): Promise<void> {
  if (vscodeApiInitPromise !== null) return vscodeApiInitPromise;
  vscodeApiInitPromise = (async () => {
    try {
      const wrapper = new MonacoVscodeApiWrapper(buildVscodeApiConfig());
      await wrapper.start();
    } catch (e) {
      // If services were already initialized (e.g. by a prior partial init),
      // start() throws — that's fine, the goal state (`vscodeApiInitialised
      // === true`) still holds. Reset the memo so a caller can retry.
      vscodeApiInitPromise = null;
      // eslint-disable-next-line no-console
      console.warn("[lspClient] vscode-api init threw (may already be init):", e);
    }
  })();
  return vscodeApiInitPromise;
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
