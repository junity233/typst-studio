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

// Idempotency guard — register only once per page load.
let registered = false;

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
export async function registerTypstHighlighting(): Promise<void> {
  if (registered) return;
  registered = true;

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

  const wasmResponse = await fetch(
    "/node_modules/@codingame/monaco-vscode-textmate-service-override/external/vscode-oniguruma/release/onig.wasm",
  );
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

  // ── Apply theme (scope→color rules) to the Registry ───────────────────
  // v25's theme service never loads "Default Light Modern", so we load the
  // bundled Light theme JSONs directly. Light+ includes Light, so we merge
  // both token-color lists: base first, plus overrides second.
  const themeBase =
    "/node_modules/@codingame/monaco-vscode-theme-defaults-default-extension/resources/";
  const [vsResp, plusResp] = await Promise.all([
    fetch(themeBase + "light_vs.json"),
    fetch(themeBase + "light_plus.json"),
  ]);
  if (!vsResp.ok || !plusResp.ok) {
    throw new Error(`theme fetch failed: vs=${vsResp.status} plus=${plusResp.status}`);
  }
  const [vsJson, plusJson] = await Promise.all([vsResp.json(), plusResp.json()]);
  const tokenColors = [
    ...(vsJson.tokenColors ?? []),
    ...(plusJson.tokenColors ?? []),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry.setTheme({ name: "light_plus", settings: tokenColors } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const colorMap = (registry as any).getColorMap() as string[];

  // ── Generate `.mtk{i}` CSS ────────────────────────────────────────────
  // Monaco's TextMate service normally generates these from the workbench
  // theme; since that doesn't work in v25, we emit them ourselves. The
  // indices match because grammar and CSS share the same color-map source.
  let css = "";
  for (let i = 1; i < colorMap.length; i++) {
    css += `.mtk${i} { color: ${colorMap[i]}; }\n`;
  }
  css += ".mtki { font-style: italic; }\n";
  css += ".mtkb { font-weight: bold; }\n";
  css += ".mtku { text-decoration: underline; text-underline-position: under; }\n";
  css += ".mtks { text-decoration: line-through; }\n";
  const styleEl = document.createElement("style");
  styleEl.className = "typst-tokens-styles";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

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
