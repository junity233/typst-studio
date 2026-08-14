/**
 * Pure tinymist runtime-config construction — no client / store / React
 * imports, so it stays unit-testable under jsdom (importing
 * `appLanguageClient` here would transitively pull Monaco's widget CSS).
 *
 * The delivery channel (workspace/didChangeConfiguration, section `tinymist`)
 * and the verification against tinymist v0.15.2 are documented in
 * [`tinymistConfig.ts`](./tinymistConfig.ts).
 */

/**
 * Build the `{ tinymist: { … } }` settings object from the app settings.
 * PURE.
 *
 * - `formatterMode`: "typstyle" | "typstfmt" (tinymist's own formatter enum;
 *   anything else falls back to typstyle, this build's server default).
 * - `printWidth`: forwarded only when > 0 (0 = leave the server default).
 */
export function buildTinymistSettings(
  formatterMode: string,
  printWidth: number,
): { tinymist: Record<string, unknown> } {
  const tinymist: Record<string, unknown> = {
    formatterMode: formatterMode === "typstfmt" ? "typstfmt" : "typstyle",
  };
  if (Number.isFinite(printWidth) && printWidth > 0) {
    tinymist.formatterPrintWidth = Math.floor(printWidth);
  }
  return { tinymist };
}
