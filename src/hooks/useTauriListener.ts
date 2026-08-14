import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * A Tauri event subscription function — the `onX` helpers from `lib/tauri`
 * (e.g. `onCompiled`). Calling it with a handler registers the listener and
 * resolves with the unlisten fn once the (async) IPC registration completes.
 */
export type TauriEventSubscribe<T> = (
  handler: (payload: T) => void,
) => Promise<UnlistenFn>;

/**
 * The race-safe bookkeeping behind {@link useTauriListener}, extracted so the
 * cancelled-flag protocol is unit-testable without rendering the hook.
 *
 * The race it closes: `onX(handler)` returns a PROMISE for the unlisten fn.
 * The naive pattern stores it in cleanup state (`onX().then(fn => unlisten =
 * fn)`), so a component that unmounts BEFORE the promise resolves runs its
 * cleanup against an unlisten that is still undefined — the listener stays
 * registered forever and fires into a dead component. The handle makes
 * "resolved" and "disposed" commutative: whichever happens first, the
 * unlisten is invoked exactly once.
 */
export interface TauriListenerHandle {
  /** The subscribe promise resolved with the unlisten fn. */
  resolved: (unlisten: UnlistenFn) => void;
  /** The subscribe promise rejected (registration failed). */
  failed: (error: unknown) => void;
  /** Effect cleanup — idempotent; releases the listener if held. */
  dispose: () => void;
}

/**
 * Create a {@link TauriListenerHandle}. `source` names the subscription for
 * error logs (the hook passes the subscribe function's name).
 */
export function createTauriListenerHandle(
  source: string,
): TauriListenerHandle {
  let disposed = false;
  let unlisten: UnlistenFn | undefined;

  return {
    resolved: (fn) => {
      if (disposed) {
        // Cleanup already ran — release immediately so the listener never
        // fires into the dead subscriber.
        fn();
        return;
      }
      unlisten = fn;
    },

    failed: (error) => {
      // After dispose nobody is listening; reporting would be noise.
      if (disposed) return;
      // A failed registration must not surface as an unhandled rejection —
      // without this catch the event chain dies silently (no listener, no
      // log). Log with the source name so the missing link is diagnosable.
      console.error(
        `[useTauriListener] failed to register "${source}" listener:`,
        error,
      );
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    },
  };
}

/**
 * Subscribe to a Tauri event for the lifetime of the mounting component.
 * Drop-in replacement for the manual `useEffect` + `onX().then(fn =>
 * unlisten = fn)` pattern, closing its unmount race (listener leaking when the
 * component unmounts before the subscribe promise resolves — see
 * {@link createTauriListenerHandle}).
 *
 * The handler is kept live via a ref, so:
 *   - a handler identity change (fresh closure every render) does NOT
 *     re-register the listener, and
 *   - the handler always sees the latest closure, like `useEffectEvent`.
 *
 * `subscribe` should be a stable module-level function (all `onX` helpers
 * are); a changing identity re-subscribes.
 *
 * Two overloads: most `onX` helpers deliver a typed payload; a few (e.g.
 * `onCloseRequested`) deliver none. The no-payload overload exists because
 * `() => void` handlers can't satisfy `(payload: T) => void` parameter
 * contravariance.
 */
export function useTauriListener<T>(
  subscribe: TauriEventSubscribe<T>,
  handler: (payload: T) => void,
): void;
export function useTauriListener(
  subscribe: (handler: () => void) => Promise<UnlistenFn>,
  handler: () => void,
): void;
// Implementation signature: the `any`s bridge the two public overloads — a
// payload-taking and a no-payload handler arity are not mutually assignable,
// but both share this one body. The overloads above carry the real types.
export function useTauriListener(
  subscribe: (handler: any) => Promise<UnlistenFn>,
  handler: any,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const handle = createTauriListenerHandle(subscribe.name || "anonymous");
    subscribe((payload: unknown) => handlerRef.current(payload)).then(
      handle.resolved,
      handle.failed,
    );
    return handle.dispose;
  }, [subscribe]);
}
