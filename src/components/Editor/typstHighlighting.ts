/**
 * Direct TextMate highlighting registration for Typst.
 *
 * WORKAROUND for monaco-vscode-api v25: the extension host doesn't process
 * `contributes` from programmatically registered extensions, so the normal
 * `extensions` field in MonacoVscodeApiConfig doesn't work for registering
 * grammars. This module bypasses the extension host entirely by:
 *
 * 1. Registering the `typst` language via `monaco.languages.register()`
 * 2. Loading the bundled `vscode-textmate` + `vscode-oniguruma` libraries
 * 3. Creating a grammar Registry with the typst TextMate grammar
 * 4. Loading the bundled Light+ theme JSON and feeding it to the Registry
 *    (v25's theme service never loads "Default Light Modern" from the bundled
 *    extension, so we must apply the theme ourselves)
 * 5. Generating `.mtk{i}` CSS rules from the Registry's color map
 * 6. Building a TokenizationSupport adapter and registering it via
 *    `TokenizationRegistry.registerFactory` (lazy — resolves on first use)
 *
 * When v34 of monaco-vscode-api is published to npm (where the extension host
 * works), this entire module can be deleted in favor of the `extensions`
 * field in MonacoVscodeApiConfig.
 */

// Grammar artifacts produced by `npm run fetch-grammar`.
import typstGrammar from "../../assets/grammar/typst.tmLanguage.json";
import typstCodeGrammar from "../../assets/grammar/typst-code.tmLanguage.json";

// Oniguruma WASM + VS Code Light theme JSONs, copied from `node_modules` into
// `public/vendor/` by `scripts/fetch-monaco-assets.mjs` (runs in the `dev` and
// `build` npm scripts, same pattern as `fetch-grammar`). We fetch them by URL
// from the served root rather than via `import`/`?url` because:
//   - the `@codingame/...` packages don't expose these files through their
//     `exports` map, so Rollup can't resolve a `?url` import at build time;
//   - the previous hardcoded `/node_modules/@codingame/...` paths only exist
//     under Vite's dev middleware (which serves node_modules directly) and 404
//     in the production build (dist/ has no node_modules/), leaving oniguruma
//     and the theme JSONs unloaded and the editor rendered unstyled.
// Serving them from `public/vendor/` makes the URL identical in dev and prod.
const ONIG_WASM_URL = "/vendor/vscode-oniguruma/onig.wasm";
const LIGHT_VS_THEME_URL = "/vendor/themes/light_vs.json";
const LIGHT_PLUS_THEME_URL = "/vendor/themes/light_plus.json";
const DARK_VS_THEME_URL = "/vendor/themes/dark_vs.json";
const DARK_PLUS_THEME_URL = "/vendor/themes/dark_plus.json";

/** The two monaco token-theme palettes we ship: light = Light+, dark = Dark+. */
export type MonacoTokenBase = "light" | "dark";

// Idempotency guard — register only once per page load.
let registrationPromise: Promise<void> | null = null;

/**
 * The shared TextMate Registry, captured during `doInit` so that later calls to
 * `applyTypstTokenTheme` can re-apply a different token palette (light/dark)
 * without rebuilding the registry (which reloads WASM + grammar). `null` until
 * the first `registerTypstHighlighting` completes its init.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedRegistry: any = null;

/**
 * The token-theme base currently applied to the registry. Avoids re-applying
 * the same palette (a no-op fetch + CSS rewrite) on every theme-store tick.
 */
let appliedTokenBase: MonacoTokenBase | null = null;

/**
 * Register the Typst language + TextMate tokenizer + theme CSS.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 *
 * Uses a lazy factory pattern: the WASM/grammar/theme loading happens
 * asynchronously, and the factory's `tokenizationSupport` Promise resolves
 * when everything is ready. Monaco's model calls `getOrCreate(languageId)`
 * on first tokenization, which awaits the factory — so the editor renders
 * immediately with a plain-text fallback, then re-renders with colors once
 * initialization completes.
 */
export function registerTypstHighlighting(): Promise<void> {
  if (registrationPromise === null) {
    registrationPromise = registerTypstHighlightingOnce().catch((error) => {
      registrationPromise = null;
      throw error;
    });
  }
  return registrationPromise;
}

async function registerTypstHighlightingOnce(): Promise<void> {

  // ── 1. Register the typst language ────────────────────────────────────
  const monaco = await import("@codingame/monaco-vscode-editor-api");
  monaco.languages.register({
    id: "typst",
    extensions: [".typ", ".typst"],
    aliases: ["Typst", "typst"],
  });

  // ── 2. Register a lazy tokenizer factory ──────────────────────────────
  // The factory's tokenizationSupport is a Promise that Monaco awaits when
  // the model first needs tokenization. This lets the WASM/theme/grammar
  // loading happen asynchronously without blocking editor creation.
  const { TokenizationRegistry } = await import(
    "@codingame/monaco-vscode-api/vscode/vs/editor/common/languages"
  );

  // The factory type expects Promise<ITokenizationSupport | null>; we cast
  // through unknown because our support object is structurally compatible but
  // not typed against Monaco's internal interface.
  TokenizationRegistry.registerFactory("typst", {
    get tokenizationSupport() {
      return createTokenizationSupport() as unknown as Promise<unknown> as never;
    },
  });
}

// Cache the promise so the heavy initialization only runs once.
let initPromise: Promise<unknown> | null = null;

async function createTokenizationSupport(): Promise<unknown> {
  if (!initPromise) {
    initPromise = doInit();
  }
  return initPromise;
}

/**
 * Apply a monaco token theme (light = Light+, dark = Dark+) to a registry and
 * (re)write the `.mtk{i}` CSS that colors token spans. Idempotent: rewrites the
 * same `<style class="typst-tokens-styles">` element in place, so it is safe to
 * call on every theme switch.
 *
 * v25's theme service never loads "Default Light/Dark Modern", so we fetch the
 * bundled theme JSONs directly. `plus` includes `vs`, so both token-color lists
 * are merged: base first, plus overrides second. Split out of `doInit` so it
 * can be re-entered to switch palettes (light ↔ dark) at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyTokenTheme(registry: any, base: MonacoTokenBase): Promise<void> {
  const vsUrl = base === "dark" ? DARK_VS_THEME_URL : LIGHT_VS_THEME_URL;
  const plusUrl = base === "dark" ? DARK_PLUS_THEME_URL : LIGHT_PLUS_THEME_URL;
  const themeName = base === "dark" ? "dark_plus" : "light_plus";

  const [vsResp, plusResp] = await Promise.all([fetch(vsUrl), fetch(plusUrl)]);
  if (!vsResp.ok || !plusResp.ok) {
    throw new Error(`theme fetch failed (${base}): vs=${vsResp.status} plus=${plusResp.status}`);
  }
  const [vsJson, plusJson] = await Promise.all([vsResp.json(), plusResp.json()]);
  const tokenColors = [
    ...(vsJson.tokenColors ?? []),
    ...(plusJson.tokenColors ?? []),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry.setTheme({ name: themeName, settings: tokenColors } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const colorMap = (registry as any).getColorMap() as string[];

  // Generate `.mtk{i}` CSS. Monaco's TextMate service normally generates these
  // from the workbench theme; since that doesn't work in v25, we emit them
  // ourselves. The indices match because grammar and CSS share the same
  // color-map source. Rewrite the same element if it exists (theme switch).
  let css = "";
  for (let i = 1; i < colorMap.length; i++) {
    css += `.mtk${i} { color: ${colorMap[i]}; }\n`;
  }
  css += ".mtki { font-style: italic; }\n";
  css += ".mtkb { font-weight: bold; }\n";
  css += ".mtku { text-decoration: underline; text-underline-position: under; }\n";
  css += ".mtks { text-decoration: line-through; }\n";
  const existing = document.querySelector("style.typst-tokens-styles");
  if (existing) {
    existing.textContent = css;
  } else {
    const styleEl = document.createElement("style");
    styleEl.className = "typst-tokens-styles";
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }
}

/**
 * Switch the Typst editor's token theme to `base` (light/dark). A no-op if
 * registration hasn't completed yet (the editor still renders with a plain-text
 * fallback, then colors in once init finishes), or if `base` is already applied.
 *
 * Waits for `registrationPromise` so the shared registry exists before
 * re-applying. Safe to call before first init — `registrationPromise` is set on
 * the first `registerTypstHighlighting` call, and `doInit` captures the same
 * registry into `sharedRegistry`.
 */
export async function applyTypstTokenTheme(base: MonacoTokenBase): Promise<void> {
  // Skip if already applied (avoids a redundant fetch + CSS rewrite on every
  // theme-store tick).
  if (appliedTokenBase === base) return;
  // Wait for the registry to exist. If registration hasn't started, there's
  // nothing to re-theme yet — `doInit` will apply the initial palette itself.
  if (registrationPromise) {
    try {
      await registrationPromise;
    } catch {
      return; // init failed; nothing to re-theme (doInit reports the error).
    }
  }
  if (!sharedRegistry) return;
  await applyTokenTheme(sharedRegistry, base);
  appliedTokenBase = base;
}

/**
 * The actual initialization: loads WASM, theme, grammar, generates CSS,
 * and returns a TokenizationSupport object compatible with Monaco.
 */
async function doInit(): Promise<unknown> {
  // ── Load vscode-textmate (bundled inside monaco-vscode-api) ───────────
  // @ts-expect-error: no types for internal virtual module
  const { main: vscodeTextmate } = await import("@codingame/monaco-vscode-api/_virtual/main");

  // ── Load vscode-oniguruma + WASM ──────────────────────────────────────
  // @ts-expect-error: no types for internal virtual module
  const onigNS = await import("@codingame/monaco-vscode-textmate-service-override/_virtual/main2");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onigModule = (onigNS as any).main ?? (onigNS as any).default;

  const wasmResponse = await fetch(ONIG_WASM_URL);
  if (!wasmResponse.ok) {
    throw new Error(`onig.wasm fetch failed: ${wasmResponse.status}`);
  }
  const wasmBuffer = await wasmResponse.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await onigModule.loadWASM({ data: wasmBuffer } as any);

  const onigLib = {
    createOnigScanner: (sources: string[]) => onigModule.createOnigScanner(sources),
    createOnigString: (str: string) => onigModule.createOnigString(str),
  };

  // ── Create a vscode-textmate Registry ─────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new vscodeTextmate.Registry({
    onigLib: Promise.resolve(onigLib),
    loadGrammar: async (scopeName: string) => {
      if (scopeName === (typstGrammar as any).scopeName) {
        return vscodeTextmate.parseRawGrammar(
          JSON.stringify(typstGrammar),
          "typst.json",
        );
      }
      if (scopeName === (typstCodeGrammar as any).scopeName) {
        return vscodeTextmate.parseRawGrammar(
          JSON.stringify(typstCodeGrammar),
          "typst-code.json",
        );
      }
      return null;
    },
  });
  // Cache the registry so `applyTypstTokenTheme` can re-apply a different
  // palette (light/dark) later without rebuilding it.
  sharedRegistry = registry;

  // ── Apply the initial token theme (light) ─────────────────────────────
  await applyTokenTheme(registry, "light");
  appliedTokenBase = "light";

  // ── Load the grammar ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grammar = await registry.loadGrammar((typstGrammar as any).scopeName);
  if (!grammar) {
    throw new Error(
      `Failed to load grammar for scope ${(typstGrammar as any).scopeName}`,
    );
  }

  // ── Build and return the TokenizationSupport ──────────────────────────
  const { EncodedTokenizationResult } = await import(
    "@codingame/monaco-vscode-api/vscode/vs/editor/common/languages"
  );
  const initialState = vscodeTextmate.INITIAL;

  return {
    getInitialState: () => initialState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokenizeEncoded(line: string, _hasEOL: boolean, state: any) {
      void _hasEOL;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (grammar as any).tokenizeLine2(line, state, 500);
      if (result.stoppedEarly) {
        console.warn(
          `[typst] tokenization time limit on: ${line.substring(0, 100)}`,
        );
        return new EncodedTokenizationResult(
          result.tokens,
          result.fonts,
          state,
        );
      }
      let endState;
      if (state.equals(result.ruleStack)) {
        endState = state;
      } else {
        endState = result.ruleStack;
      }
      return new EncodedTokenizationResult(
        result.tokens,
        result.fonts,
        endState,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokenize(_line: string, _hasEOL: boolean, _state: any) {
      throw new Error("Not supported!");
    },
  };
}
