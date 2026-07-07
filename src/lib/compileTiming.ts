/**
 * Compile-pipeline diagnostic timing (TEMPORARY — remove after measurement).
 *
 * `duration_ms` from the backend only covers `typst::compile` (③). This module
 * measures the FRONT-END portion of perceived latency so we can attribute the
 * gap between the status bar's "tens of ms" and the felt ~1s:
 *
 *   ⑦ IPC transfer (backend emit → onCompiled handler)
 *   ⑧ JSON deserialization (implicit in the listener firing)
 *   ⑨ React transition lag (startTransition deferring setPages commit)
 *   ⑩ blob creation + <img> decode (setPages commit → last page's onLoad)
 *
 * Flow:
 *   1. `markReceived(revision, pages, backendEmitMs?)` — called the instant the
 *      `compiled` event arrives in the JS listener (before startTransition).
 *   2. `markCommitted(revision)` — called inside the transition, right after
 *      `setPages` runs.
 *   3. `markPageDecoded(revision, pageNumber)` — called from each `<img>`'s
 *      onLoad. When all N pages of that revision have decoded, the full
 *      breakdown is printed once to the console.
 *
 * Only active when `import.meta.env.DEV` is true; in production builds every
 * function is a no-op so this file imposes zero runtime cost when shipped.
 */

type Pending = {
  /** performance.now() at the moment the compiled event reached the listener. */
  receivedAt: number;
  /** Number of pages we expect to decode (== pages.length). */
  pageCount: number;
  /** duration_ms from the payload (③ typst::compile) for reference. */
  backendCompileMs: number;
  /** performance.now() when setPages committed inside the transition (⑨). */
  committedAt: number | null;
  /** Set of page numbers (1-indexed) whose <img> has fired onLoad. */
  decodedPages: Set<number>;
  /** Largest decode finish time seen so far (for the "all decoded" mark). */
  lastDecodeAt: number;
};

const pending = new Map<number, Pending>();

const DEV = typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Record the moment a `compiled` event arrives in the JS listener. This is the
 * end of ⑦/⑧ (IPC + deserialize) and the start of ⑨ (transition wait).
 */
export function markReceived(
  revision: number,
  pageCount: number,
  backendCompileMs: number,
): void {
  if (!DEV) return;
  pending.set(revision, {
    receivedAt: performance.now(),
    pageCount,
    backendCompileMs,
    committedAt: null,
    decodedPages: new Set(),
    lastDecodeAt: 0,
  });
  // Keep the map bounded: drop entries older than the newest few revisions.
  if (pending.size > 5) {
    const oldest = Math.min(...pending.keys());
    pending.delete(oldest);
  }
}

/**
 * Record that `setPages` committed for this revision (called inside the
 * transition). The gap from `receivedAt` to here is the ⑨ transition lag.
 */
export function markCommitted(revision: number): void {
  if (!DEV) return;
  const p = pending.get(revision);
  if (p) p.committedAt = performance.now();
}

/**
 * Record that one page's `<img>` finished decoding. When all pages of that
 * revision have decoded, print the full breakdown and delete the entry.
 */
export function markPageDecoded(revision: number, pageNumber: number): void {
  if (!DEV) return;
  const p = pending.get(revision);
  if (!p) return;
  p.decodedPages.add(pageNumber);
  p.lastDecodeAt = performance.now();
  if (p.decodedPages.size < p.pageCount) return;

  // All pages decoded — emit the breakdown. Note: ⑦ (IPC transfer) and ⑧
  // (deserialize) can't be split front-side — the listener fires only after
  // both complete — so the front-end clock starts at listener fire and ⑨+⑩
  // are the splittable parts.
  const now = p.lastDecodeAt;
  const commitLag = p.committedAt != null ? p.committedAt - p.receivedAt : NaN;
  const decodeMs = p.committedAt != null ? now - p.committedAt : NaN;
  const totalFrontMs = now - p.receivedAt;
  // eslint-disable-next-line no-console
  console.debug(
    `[compile-timing] rev=${revision} ` +
      `backendCompileMs=${p.backendCompileMs} (③) ` +
      `pages=${p.pageCount} ` +
      `transitionLagMs=${commitLag.toFixed(0)} (⑨) ` +
      `blobDecodeMs=${decodeMs.toFixed(0)} (⑩) ` +
      `totalFrontMs=${totalFrontMs.toFixed(0)} (⑨+⑩)`,
  );
  pending.delete(revision);
}
