/**
 * Dev-gated logger for the AI-assistant hot path.
 *
 * The assistant code path (assistantStore / aiStream / tauriFetch / aiProxy)
 * historically left ~19 `console.log` calls active in PRODUCTION builds. Two
 * problems resulted:
 *
 *  1. PRIVACY — several of those calls `JSON.stringify` user message text or
 *     tool arguments, so the user's content is dumped to the devtools console
 *     on every turn. A shipped desktop app must not echo user content to a
 *     globally visible console.
 *  2. PERF — the logging fires on every stream chunk and every agent
 *     lifecycle event, adding real overhead in long conversations (and the
 *     `JSON.stringify` of large transcripts/args is the expensive part).
 *
 * `aiLog` is THE established dev-gating convention. It mirrors
 * `src/lib/compileTiming.ts`, which uses `import.meta.env.DEV` (Vite-injected
 * and statically replaced at build time — the dead branch is tree-shaken out
 * of production). `src/i18n/index.ts` uses the same flag. See those files for
 * precedent.
 *
 * ## Design: how it achieves a prod no-op + cheap call sites
 *
 * `aiLog` is bound at module-eval time to either a real logger (DEV) or a
 * completely empty `() => {}` (prod). So in production the function body does
 * nothing — no formatting, no console call.
 *
 * Call sites pass RAW values, never `JSON.stringify(...)`. Example:
 *   `aiLog("sendMessage start:", text)`  // NOT `JSON.stringify(text)`
 *
 * Rationale: argument expressions are evaluated at the CALL SITE before the
 * function is entered, so a plain `function aiLog(...args){ if(!DEV) return; }`
 * would STILL pay for `JSON.stringify(text)` in prod even though the result is
 * discarded. By (a) making `aiLog` an empty function in prod (no logging at
 * all) AND (b) dropping `JSON.stringify` from every call site (pass the raw
 * value and let the DEV logger format it via `console.log`'s native object
 * rendering), call sites stay cheap in BOTH modes and nothing logs in prod.
 *
 * The `[ai]` prefix is always emitted by `aiLog` itself in DEV; pass a
 * sub-prefix (e.g. `"[stream]"`, `"[fetch]"`) as the first arg to preserve the
 * existing categorization in dev logs. In production none of this runs.
 *
 * Only active when `import.meta.env.DEV` is true; in production builds this
 * module imposes zero runtime cost (the export is a no-op function and the
 * call sites pass already-cheap raw values).
 */

const DEV = import.meta.env.DEV;

/**
 * Log to the console in DEV only. In production this is an empty function —
 * nothing is evaluated for formatting and nothing is written. Pass raw values
 * (not `JSON.stringify` results); `console.log` renders objects natively.
 *
 * @example
 * aiLog("sendMessage start:", text);
 * aiLog("[stream] driveStream start:", { provider, modelId, baseUrl });
 */
export const aiLog: (...args: unknown[]) => void = DEV
  ? (...args) => console.log("[ai]", ...args)
  : () => {};
