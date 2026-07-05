import type { MonacoVscodeApiConfig } from "monaco-languageclient/vscodeApiWrapper";
import {
  getEnhancedMonacoEnvironment,
  MonacoVscodeApiWrapper,
} from "monaco-languageclient/vscodeApiWrapper";
import { Uri } from "vscode";
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
    // Mark the embedded workbench's workspace as TEMPORARY so it does NOT
    // persist/restore editor-group state (the real fix for the recurring
    // `Unable to read file '.../Documents/typst/Untitled.typ'` error).
    //
    // Typst Studio owns its documents entirely: open/close/restore goes through
    // our Zustand stores + [`monacoModelRegistry`](./monacoModelRegistry.ts),
    // and the editor is driven by `editor.setModel` directly — never through
    // the workbench's `IEditorService.openEditor`. The workbench editor part,
    // however, is mounted (because `viewsConfig.$type === "EditorService"` needs
    // an editor pane container) and would otherwise revive any editor input it
    // persisted to browser storage on a previous run. That revival path reads
    // each revived input's resource from disk — and a leftover untitled-with-
    // associated-path editor (path = workspace root + Save-As default name
    // "Untitled.typ") produces a failing read of a nonexistent file, racing our
    // registry-owned Typst model and breaking tokenization.
    //
    // The gate is `isTemporaryWorkspace(workspace)` (returns true when the
    // workspace `configuration` URI's scheme is `tmp`). A temporary workspace
    // makes `shouldRestoreEditors()` return `false` → `restorePreviousState:
    // false` on the editor part → it skips reviving persisted editor inputs
    // entirely. Since we never open workbench editor inputs, nothing is ever
    // persisted either, so a fresh workspace stays clean.
    //
    // The `workspaceUri` (not `folderUri`) form is required: single-folder
    // workspaces set `Workspace.configuration = null`, which `isTemporaryWorkspace`
    // never treats as temporary regardless of the folder URI's scheme. A
    // multi-root workspace carries its config path as `Workspace.configuration`,
    // so a `tmp:`-scheme `workspaceUri` is detected as temporary. The `tmp:`
    // URI has no file-service provider, so the workspace-config reader resolves
    // to an empty folder list — harmless, since the app doesn't use the
    // workbench's workspace folders (tinymist's root comes from
    // `workspaceRootPath` via `appLanguageClient`, independently).
    //
    // The `userConfiguration` settings below (`workbench.startupEditor: none`,
    // `window.restoreWindows: none`) are kept as a secondary defense, but on
    // their own they do NOT suppress the non-empty-workspace editor-group
    // restore — only the temporary-workspace gate does.
    workspaceConfig: {
      workspaceProvider: {
        // A throwaway `tmp:`-scheme workspace file URI. Stable string is fine:
        // it only needs to look like a multi-root workspace config so the
        // resolved `Workspace.configuration` carries the `tmp` scheme.
        workspace: { workspaceUri: Uri.parse("tmp://typst-studio/workspace.code-workspace") },
        trusted: true,
        // The app never calls window-reopen; a no-op satisfies the interface.
        async open() {
          return true;
        },
      },
    },
    userConfiguration: {
      // NOTE: In monaco-vscode-api v25, the workbench theme service never
      // actually loads this theme from the bundled extension. The real theme
      // + token CSS is applied manually by typstHighlighting.ts. This entry
      // is kept for forward compatibility (v34+ loads it properly).
      //
      // Secondary defense against the workbench's own startup editor flow (see
      // the `workspaceConfig` comment above for the primary fix). These do not
      // suppress editor-group restore on their own.
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
