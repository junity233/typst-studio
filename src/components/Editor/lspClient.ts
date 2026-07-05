import type { MonacoVscodeApiConfig } from "monaco-languageclient/vscodeApiWrapper";
import {
  getEnhancedMonacoEnvironment,
  MonacoVscodeApiWrapper,
} from "monaco-languageclient/vscodeApiWrapper";
import baseServiceOverride from "@codingame/monaco-vscode-base-service-override";
import filesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import { servicesInitialized } from "@codingame/monaco-vscode-api/lifecycle";
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";

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
    serviceOverrides: {
      ...baseServiceOverride(),
      ...filesServiceOverride(),
    },
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
      //
      // Also disable the VS Code workbench's own editor restore/startup flow.
      // Typst Studio renders and restores documents through our Zustand stores
      // + monacoModelRegistry; letting the embedded workbench open its own
      // hidden "startup" editor can spawn an extra untitled/file working copy
      // (observed on Windows as a failing read of Documents/Untitled.typ),
      // which races our registry-owned Typst model and leaves tokenization in
      // a broken state. We want exactly one editor session: ours.
      json: JSON.stringify({
        "workbench.colorTheme": "Default Light Modern",
        "workbench.startupEditor": "none",
        "window.restoreWindows": "none",
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

function isServicesAlreadyInitializedError(error: unknown): boolean {
  if (error instanceof Error) {
    return /Services are already initialized/i.test(error.message);
  }
  if (typeof error === "string") {
    return /Services are already initialized/i.test(error);
  }
  return false;
}

export function ensureVscodeApiInitialized(): Promise<void> {
  if (vscodeApiInitPromise !== null) return vscodeApiInitPromise;
  vscodeApiInitPromise = (async () => {
    const wrapper = new MonacoVscodeApiWrapper(buildVscodeApiConfig());
    try {
      await wrapper.start();
      getEnhancedMonacoEnvironment().vscodeApiInitialising = false;
    } catch (e) {
      // If services were already initialized (e.g. by a prior partial init),
      // start() can still throw before monaco-languageclient flips its own
      // `vscodeApiInitialised` flag. In that case, COMPLETE the wrapper's
      // global-init bookkeeping manually so later mounts see a coherent state
      // (`servicesInitialized === true` AND `vscodeApiInitialised === true`).
      if (
        servicesInitialized &&
        isServicesAlreadyInitializedError(e)
      ) {
        (
          wrapper as unknown as {
            markGlobalInitDone: () => void;
          }
        ).markGlobalInitDone();
        getEnhancedMonacoEnvironment().vscodeApiInitialising = false;
        return;
      }
      // Unexpected failure: reset the memo so a caller can retry.
      vscodeApiInitPromise = null;
      // eslint-disable-next-line no-console
      console.warn("[lspClient] vscode-api init failed:", e);
      throw e;
    }
  })();
  return vscodeApiInitPromise;
}
