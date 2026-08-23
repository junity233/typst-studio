/**
 * A process-wide ordering token for window-level Escape listeners.
 *
 * The problem: several dialogs/popups attach independent window keydown
 * listeners. `stopPropagation` cannot help — it only stops propagation across
 * the DOM tree, NOT other listeners on the SAME target (that would be
 * `stopImmediatePropagation`, and even that follows registration order, not
 * visual z-order). With stacked modals one Escape press fired every open
 * layer's handler and closed all of them at once.
 *
 * The fix: each active layer takes a monotonically increasing "depth" ticket
 * on activation and releases it on unmount. Only the ticket that is currently
 * the maximum acts on Escape; lower layers ignore the event. This mirrors a
 * real modal stack — topmost first — with no central registry of components.
 *
 * Pure module state + exported helpers so tests can pin the semantics without
 * rendering anything.
 */
let nextDepth = 0;
const activeDepths = new Set<number>();

/** A live stack ticket: query topmost-ness and release it. */
export interface EscapeDepth {
  /** True iff this ticket is the highest currently-active one. */
  isTopmost(): boolean;
  /** Release the ticket (idempotent). */
  release(): void;
}

/**
 * Take a stack ticket. Tickets are strictly increasing, so the LAST acquired
 * active ticket is always the topmost layer — matching the order React
 * effects run for portals mounted later (visually above earlier ones).
 */
export function acquireEscapeDepth(): EscapeDepth {
  const depth = ++nextDepth;
  activeDepths.add(depth);
  let released = false;
  return {
    isTopmost() {
      if (released) return false;
      let max = -Infinity;
      for (const d of activeDepths) {
        if (d > max) max = d;
      }
      return depth === max;
    },
    release() {
      if (!released) {
        released = true;
        activeDepths.delete(depth);
      }
    },
  };
}
