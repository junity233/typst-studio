// @ts-check
/**
 * Copy runtime resource files (oniguruma WASM + VS Code Light theme JSONs)
 * out of `@codingame/monaco-vscode-*` packages into `public/vendor/`.
 *
 * `typstHighlighting.ts` fetches these by URL from the served site root
 * (`/vendor/...`). Vite serves `public/` at root in dev and copies it as-is
 * into `dist/` in the production build, so the URL is identical in both —
 * unlike `/node_modules/@codingame/...` literals, which 404 under `vite build`
 * (dist/ has no node_modules/) and leave the editor unstyled.
 *
 * An `import ...?url` would be cleaner, but these packages don't expose the
 * files through their `exports` map, so Rollup can't resolve them at build
 * time. Mirroring into `public/vendor/` is the reliable fallback.
 *
 * Idempotent: re-runs overwrite in place. Source paths are asserted to exist
 * so an upstream package layout change fails loudly instead of silently
 * shipping a broken build.
 *
 * Runs in the `dev` and `build` npm scripts alongside `fetch-grammar`.
 */

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Source (in node_modules) → destination (under public/vendor/).
 * @type {Array<[string, string]>}
 */
const ASSETS = [
  [
    "node_modules/@codingame/monaco-vscode-textmate-service-override/external/vscode-oniguruma/release/onig.wasm",
    "public/vendor/vscode-oniguruma/onig.wasm",
  ],
  [
    "node_modules/@codingame/monaco-vscode-theme-defaults-default-extension/resources/light_vs.json",
    "public/vendor/themes/light_vs.json",
  ],
  [
    "node_modules/@codingame/monaco-vscode-theme-defaults-default-extension/resources/light_plus.json",
    "public/vendor/themes/light_plus.json",
  ],
];

function main() {
  for (const [srcRel, destRel] of ASSETS) {
    const src = resolve(ROOT, srcRel);
    const dest = resolve(ROOT, destRel);
    // Assert the source exists — a missing file means the dependency layout
    // changed upstream, and we'd rather fail the build than ship without
    // highlighting.
    try {
      statSync(src);
    } catch {
      throw new Error(`monaco asset source missing: ${src}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`[fetch-monaco-assets] ${srcRel} → ${destRel}`);
  }
  console.log("[fetch-monaco-assets] done");
}

main();
