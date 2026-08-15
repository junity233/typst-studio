import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Ref-counted single-subscription factory — the shared lifecycle behind
 * `lspStore` and `tinymistInstallStore`'s "one fetch + one event listener,
 * shared app-wide" pattern. The first reader triggers one `fetch()` seed +
 * one `listen()`, all readers share the state; the subscription is torn down
 * when the last reader unmounts (`refCount`), deferred to a microtask so a
 * synchronous unmount+remount (tab switch, React re-render) doesn't tear down
 * and rebuild it.
 *
 * Per-store shape:
 * - `fetch` — the initial-state IPC, raced against `timeoutMs` so a hung IPC
 *   can't leave readers gated on a loading state forever. Its result goes
 *   through `apply` (which may map or gate it) before the event stream takes
 *   over.
 * - `listen` — returns the single unlisten handle, kept while `refCount > 0`.
 * - `apply` — the wire-payload → store transition (mapping, generation gates,
 *   etc.); every fetched and pushed payload funnels through it.
 *
 * The whole "fetch once + listen once" sequence is collapsed into a single
 * memoized Promise so concurrent mounters (e.g. StatusBar + MonacoEditor
 * mounting in the same render) all await the same in-flight operation —
 * `listen()` runs exactly once, and the returned unlisten handle is never
 * overwritten by a late-resolving duplicate.
 */
export function createRefCountedSubscription<TEvent>(options: {
  /** Initial-state fetch (the store's seed), raced against a timeout. */
  fetch: () => Promise<TEvent>;
  /** Subscribe to the push event; resolves to the single unlisten handle. */
  listen: (onEvent: (p: TEvent) => void) => Promise<UnlistenFn>;
  /** Apply a fetched or pushed wire payload to the store (mapping + gates). */
  apply: (payload: TEvent) => void;
  /** Abort the initial fetch after this long (local IPC resolves in ms). */
  timeoutMs?: number;
  /** Message for the timeout rejection. */
  timeoutLabel: string;
  setLoading: (loading: boolean) => void;
  setRefCount: (fn: (n: number) => number) => void;
  getRefCount: () => number;
}): {
  /**
   * The subscriber hook: bump `refCount` on mount (lazy-acquiring the shared
   * subscription), decrement + microtask-deferred release on unmount.
   */
  useSubscription: () => void;
} {
  const {
    fetch,
    listen,
    apply,
    timeoutMs = 5000,
    timeoutLabel,
    setLoading,
    setRefCount,
    getRefCount,
  } = options;

  let acquirePromise: Promise<UnlistenFn> | null = null;

  /**
   * Start (or join an in-progress) subscription. Resolves to the single unlisten
   * handle. Idempotent: concurrent callers share one Promise and one `listen()`.
   * If the acquire itself fails (shouldn't, but be safe), clear the memo so a
   * later mount can retry instead of being stuck on a rejected promise.
   */
  function acquire(): Promise<UnlistenFn> {
    if (acquirePromise !== null) return acquirePromise;

    acquirePromise = (async () => {
      try {
        const initial = await Promise.race<TEvent>([
          fetch(),
          new Promise<TEvent>((_, reject) =>
            setTimeout(() => reject(new Error(timeoutLabel)), timeoutMs),
          ),
        ]);
        apply(initial);
      } catch {
        // ignore — the event subscription catches up if the backend recovers.
      } finally {
        setLoading(false);
      }

      // Exactly one listen() per acquirePromise. The handle is returned to the
      // caller; release happens only when refCount drops to 0 (see below).
      return listen((p) => apply(p));
    })();

    acquirePromise.catch(() => {
      acquirePromise = null;
    });

    return acquirePromise;
  }

  /**
   * Release the shared subscription when no readers remain. We don't await
   * acquirePromise here — if a mount/unmount/remount cycle happens within the
   * fetch window, the refCount going 1→0→1 means a new acquire joins the
   * still-in-flight promise (idempotent), and the eventual release (when
   * refCount truly hits 0) unhooks the one and only listener. If the acquire
   * rejects (listen() failed), there is no unlisten handle to call — and the
   * .catch above already cleared acquirePromise; swallow the derived rejection
   * to avoid an unhandled-rejection warning.
   */
  function release(): void {
    if (getRefCount() === 0 && acquirePromise !== null) {
      const pending = acquirePromise;
      acquirePromise = null;
      void pending.then(
        (unlisten) => unlisten(),
        () => {},
      );
    }
  }

  function useSubscription(): void {
    useEffect(() => {
      setRefCount((n) => n + 1);
      if (acquirePromise === null) {
        acquire();
      }
      return () => {
        setRefCount((n) => n - 1);
        queueMicrotask(() => {
          release();
        });
      };
    }, [setRefCount]);
  }

  return { useSubscription };
}
