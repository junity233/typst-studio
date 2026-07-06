import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const projectRoot = dirname(fileURLToPath(import.meta.url));

// @codingame/monaco-vscode-* packages register their resources (grammars,
// theme JSONs, NLS files) via `new URL('./resources/...json', import.meta.url)`.
// Vite's dep optimizer pre-bundles these into per-package chunks under
// `node_modules/.vite/deps/`, which rewrites `import.meta.url` to the chunk's
// URL and breaks relative resolution of `./resources/...` (every JSON returns
// 404, theme JSONs never load, the editor renders unstyled). Excluding these
// packages from pre-bundling keeps `import.meta.url` pointing at the real file
// in node_modules, so `./resources/...` resolves correctly under Vite's `/node_modules/...`
// dev serving.
const MONACO_VSCODE_RESOURCE_PACKAGES = [
  "@codingame/monaco-vscode-theme-defaults-default-extension",
  "@codingame/monaco-vscode-textmate-service-override",
];

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    // Restrict which on-disk files the dev server will serve. When
    // `TAURI_DEV_HOST` is set the server binds to a (possibly LAN-reachable)
    // interface; without this allow-list the entire repo + node_modules would
    // be servable to anyone on the network. Restricting to the workspace root
    // keeps the surface to the app's own sources + dependencies.
    fs: {
      allow: [projectRoot],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  resolve: {
    // Required for monaco-languageclient / @codingame/monaco-vscode-api
    dedupe: ["vscode"],
  },

  optimizeDeps: {
    exclude: MONACO_VSCODE_RESOURCE_PACKAGES,
  },

  worker: {
    format: "es",
  },
});
