// @ts-check
/**
 * Fetch tinymist's TextMate grammar (+ language-configuration + manifest slice)
 * from OpenVSX and write them into src/assets/grammar/.
 *
 * The grammar JSONs are build artifacts inside the published VSIX (not committed
 * upstream), so this script:
 *   1. Downloads the universal VSIX (2.5 MB, CORS-enabled) from OpenVSX.
 *   2. Streams the zip and extracts only the files we need, including the
 *      extension's package.json.
 *   3. Slices that package.json's contributes block into a minimal manifest
 *      we register as a web extension (this carries semanticTokenScopes, the
 *      crucial bridge from LSP semantic tokens → TextMate scopes → theme colors).
 *
 * Output is checked by the build (`tsc` imports the manifest), so a successful
 * `npm run fetch-grammar` is a hard prerequisite for `npm run build` / `dev`.
 *
 * Idempotent + cache-aware: the VSIX is cached at
 * `node_modules/.cache/grammar/tinymist-<version>.vsix` so offline rebuilds work
 * after the first fetch.
 *
 * Versioning: pin TINYMIST_VERSION below. Bumping is a one-line change; CI will
 * fail loudly if upstream changes the grammar shape (the scopeName assertion at
 * the end).
 */

import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Pinned tinymist release we pull grammar artifacts from. */
const TINYMIST_VERSION = "0.15.2";

const OPENVSX_VSIX_URL = `https://open-vsx.org/api/myriad-dreamin/tinymist/${TINYMIST_VERSION}/file/myriad-dreamin.tinymist-${TINYMIST_VERSION}.vsix`;
const CACHE_DIR = resolve(ROOT, "node_modules/.cache/grammar");
const CACHE_VSIX = resolve(CACHE_DIR, `tinymist-${TINYMIST_VERSION}.vsix`);
const CACHE_MANIFEST = resolve(CACHE_DIR, `tinymist-${TINYMIST_VERSION}-package.json`);

const OUT_DIR = resolve(ROOT, "src/assets/grammar");
const OUT = {
  typstGrammar: resolve(OUT_DIR, "typst.tmLanguage.json"),
  typstCodeGrammar: resolve(OUT_DIR, "typst-code.tmLanguage.json"),
  languageConfiguration: resolve(OUT_DIR, "language-configuration.json"),
  manifest: resolve(OUT_DIR, "manifest.json"),
};

/** Paths inside the VSIX zip we care about → destination file. */
const ZIP_ENTRIES = {
  "extension/out/typst.tmLanguage.json": OUT.typstGrammar,
  "extension/out/typst-code.tmLanguage.json": OUT.typstCodeGrammar,
  "extension/syntaxes/language-configuration.json": OUT.languageConfiguration,
  "extension/package.json": CACHE_MANIFEST,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<void>} */
async function ensureVsixCached() {
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    statSync(CACHE_VSIX);
    console.log(`[fetch-grammar] using cached VSIX: ${CACHE_VSIX}`);
    return;
  } catch {
    // not cached — fall through and download
  }
  console.log(`[fetch-grammar] downloading ${OPENVSX_VSIX_URL}`);
  const res = await fetch(OPENVSX_VSIX_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`VSIX download failed: HTTP ${res.status} ${res.statusText}`);
  }
  // Node's fetch web streams need conversion to a Node stream for pipeline().
  await pipeline(Readable.fromWeb(/** @type {any} */ (res).body), createWriteStream(CACHE_VSIX));
  const size = statSync(CACHE_VSIX).size;
  console.log(`[fetch-grammar] cached VSIX (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

/**
 * Stream-extract the entries listed in ZIP_ENTRIES from the cached VSIX.
 * @returns {Promise<void>}
 */
function extractEntries() {
  return new Promise((resolvePromise, reject) => {
    const remaining = new Set(Object.keys(ZIP_ENTRIES));
    yauzl.open(CACHE_VSIX, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("failed to open VSIX"));
        return;
      }
      zip.readEntry();
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        const dest = ZIP_ENTRIES[/** @type {keyof typeof ZIP_ENTRIES} */ (entry.fileName)];
        if (!dest) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) {
            reject(e ?? new Error(`openReadStream failed for ${entry.fileName}`));
            return;
          }
          /** @type {Buffer[]} */
          const chunks = [];
          stream.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
          stream.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            // Pretty-print so the committed/stored file is diff-friendly.
            const json = JSON.stringify(JSON.parse(text), null, 2);
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, json);
            console.log(`[fetch-grammar] extracted ${entry.fileName} → ${dest}`);
            remaining.delete(entry.fileName);
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("close", () => {
        if (remaining.size > 0) {
          reject(new Error(`missing VSIX entries: ${[...remaining].join(", ")}`));
        } else {
          resolvePromise();
        }
      });
      zip.on("error", reject);
    });
  });
}

/**
 * Slice the package.json extracted from the pinned VSIX into the contributes
 * keys relevant to highlighting, sanitizing references we can't or don't want
 * to satisfy. Reading it from the VSIX keeps the grammar and manifest versions
 * atomic and means cached builds require no network access.
 *
 * Sanitization rules:
 *   - Drop the `typst-markdown-injection` language + its grammar — we don't
 *     edit Markdown in typst-studio, and the grammar file would otherwise be an
 *     unresolvable reference (we don't ship it).
 *   - Drop the `icon` field from each language — we don't show file icons in
 *     the Monaco editor, and bundling tinymist's PNGs just for the manifest
 *     isn't worth it.
 *   - Drop the `toml` language entry — only there so tinymist's lockfile is
 *     recognized; irrelevant to us.
 *
 * Everything else (grammars, semanticTokenScopes, configurationDefaults) is
 * kept verbatim from upstream so semantic highlighting stays in sync with the
 * grammar version.
 * @returns {void}
 */
function writeManifestSlice() {
  /** @type {any} */
  const pkg = JSON.parse(readFileSync(CACHE_MANIFEST, "utf8"));
  const upstream = pkg.contributes ?? {};

  // Keep only Typst + Typst-code languages (drop toml + markdown-injection).
  const languages = (upstream.languages ?? [])
    .filter((/** @type {any} */ l) => l.id === "typst" || l.id === "typst-code")
    .map((/** @type {any} */ l) => {
      // Strip the icon reference — we don't bundle tinymist's PNGs and an
      // unresolvable icon path causes noisy 404s in the asset resolver.
      const { icon: _icon, ...rest } = l;
      void _icon;
      return rest;
    });

  // Keep only the typst + typst-code grammars (drop markdown injection).
  const grammars = (upstream.grammars ?? []).filter((/** @type {any} */ g) =>
    g.scopeName === "source.typst" || g.scopeName === "source.typst-code",
  );

  const manifest = {
    name: "tinymist-grammar",
    publisher: "typst-studio",
    version: TINYMIST_VERSION,
    engines: { vscode: pkg.engines?.vscode ?? "^1.97.0" },
    contributes: {
      languages,
      grammars,
      semanticTokenTypes: upstream.semanticTokenTypes,
      semanticTokenModifiers: upstream.semanticTokenModifiers,
      semanticTokenScopes: upstream.semanticTokenScopes,
      configurationDefaults: upstream.configurationDefaults,
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT.manifest, JSON.stringify(manifest, null, 2));
  console.log(`[fetch-grammar] wrote manifest → ${OUT.manifest}`);
}

/**
 * Sanity-check the extracted grammar: scopeName must match what the manifest
 * declares, otherwise the wrapper silently fails to tokenize.
 * @returns {void}
 */
function verify() {
  /** @type {any} */
  const typst = JSON.parse(readFileSync(OUT.typstGrammar, "utf8"));
  if (typst.scopeName !== "source.typst") {
    throw new Error(`typst.tmLanguage.json: expected scopeName "source.typst", got ${typst.scopeName}`);
  }
  /** @type {any} */
  const code = JSON.parse(readFileSync(OUT.typstCodeGrammar, "utf8"));
  if (code.scopeName !== "source.typst-code") {
    throw new Error(`typst-code.tmLanguage.json: expected scopeName "source.typst-code", got ${code.scopeName}`);
  }
  /** @type {any} */
  const manifest = JSON.parse(readFileSync(OUT.manifest, "utf8"));
  const grammarPaths = (manifest.contributes?.grammars ?? []).map((/** @type {{ path: string }} */ g) => g.path);
  for (const p of ["./out/typst.tmLanguage.json", "./out/typst-code.tmLanguage.json"]) {
    if (!grammarPaths.includes(p)) {
      throw new Error(`manifest missing grammar path ${p}; upstream may have changed shape`);
    }
  }
  console.log("[fetch-grammar] verification passed");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Start fresh so a corrupted/incomplete OUT_DIR can't silently satisfy the
  // build's imports.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  await ensureVsixCached();
  await extractEntries();
  writeManifestSlice();
  verify();

  console.log(`[fetch-grammar] done (tinymist v${TINYMIST_VERSION})`);
}

main().catch((e) => {
  console.error("[fetch-grammar] FAILED:", e);
  process.exit(1);
});
