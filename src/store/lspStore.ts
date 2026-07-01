import { useEffect } from "react";
import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { onLspStatus } from "../lib/tauri";

/**
 * LSP connection status, shared app-wide via a single subscription.
 *
 * Previously `StatusBar` and `MonacoEditor` each ran their own
 * `get_lsp_status` fetch + `lsp_status` event listener. This store collapses
 * that to one fetch and one listener: the first component to mount triggers
 * the subscription; all readers see the same state with no duplicate IPC.
 *
 * The subscription is established lazily on first `useLspStatus()` call and
 * torn down when the last reader unmounts (`refCount`).
 */
export interface LspStatus {
  running: boolean;
  wsUrl: string;
  available: boolean;
}

interface LspStoreState {
  status: LspStatus;
  loading: boolean;
  /** Bumped by each subscriber; the subscription is held while > 0. */
  refCount: number;
  /** Internal: set by the store actions, not by callers. */
  setStatus: (s: LspStatus) => void;
  setLoading: (b: boolean) => void;
  setRefCount: (fn: (n: number) => number) => void;
}

const OFFLINE: LspStatus = { running: false, wsUrl: "", available: false };

export const useLspStore = create<LspStoreState>((set) => ({
  status: OFFLINE,
  loading: true,
  refCount: 0,
  setStatus: (s) => set({ status: s }),
  setLoading: (b) => set({ loading: b }),
  setRefCount: (fn) =>
    set((state) => ({ refCount: Math.max(0, fn(state.refCount)) })),
}));

// --- the single shared subscription -----------------------------------------
//
// The subscription is established lazily and shared across all readers. The
// whole "fetch once + listen once" sequence is collapsed into a single
// memoized Promise so concurrent mounters (StatusBar + MonacoEditor mount in
// the same render) all await the same in-flight operation — `listen()` runs
// exactly once, and the returned unlisten handle is never overwritten by a
// late-resolving duplicate.

let acquirePromise: Promise<UnlistenFn> | null = null;

/**
 * Start (or join an in-progress) subscription. Resolves to the single unlisten
 * handle. Idempotent: concurrent callers share one Promise and one `listen()`.
 */
function acquireSubscription(): Promise<UnlistenFn> {
  if (acquirePromise !== null) return acquirePromise;

  acquirePromise = (async () => {
    // Seed with the current status so readers aren't stuck "offline" before
    // the first transition. Race against a timeout so a hung IPC can't leave
    // the editor gated on "Loading..." forever — local IPC resolves in ms,
    // 5s is a generous backstop.
    try {
      const initial = await Promise.race<LspStatus>([
        invoke<LspStatus>("get_lsp_status"),
        new Promise<LspStatus>((_, reject) =>
          setTimeout(
            () => reject(new Error("get_lsp_status timed out")),
            5000,
          ),
        ),
      ]);
      useLspStore.getState().setStatus(initial);
    } catch {
      // ignore — the event subscription catches up if the backend recovers.
    } finally {
      useLspStore.getState().setLoading(false);
    }

    // Exactly one listen() per acquirePromise. The handle is returned to the
    // caller; release happens only when refCount drops to 0 (see below).
    return onLspStatus((p) => useLspStore.getState().setStatus(p));
  })();

  // If the acquire itself fails (shouldn't, but be safe), clear the memo so a
  // later mount can retry instead of being stuck on a rejected promise.
  acquirePromise.catch(() => {
    acquirePromise = null;
  });

  return acquirePromise;
}

function releaseSubscription(): void {
  // Only release when no readers remain. We don't await acquirePromise here —
  // if a mount/unmount/remount cycle happens within the fetch window, the
  // refCount going 1→0→1 means a new acquire joins the still-in-flight
  // promise (idempotent), and the eventual release (when refCount truly hits
  // 0) unhooks the one and only listener.
  if (useLspStore.getState().refCount === 0 && acquirePromise !== null) {
    const pending = acquirePromise;
    acquirePromise = null;
    // If the acquire rejects (listen() failed), there is no unlisten handle
    // to call — and the .catch above already cleared acquirePromise. Swallow
    // the derived rejection here to avoid an unhandled-rejection warning.
    void pending.then(
      (unlisten) => unlisten(),
      () => {},
    );
  }
}

/**
 * Read LSP status with a single shared subscription. Mount this in any
 * component that needs `status` or `loading`; the subscription is ref-counted
 * so it stays alive while at least one reader is mounted.
 *
 * Lifecycle: the first mount triggers `acquireSubscription()` (fetch + listen,
 * memoized so concurrent mounters share one operation). Each mount bumps
 * `refCount`; cleanup decrements it. When it reaches zero we release, but the
 * release is deferred to a microtask so a synchronous unmount+remount (tab
 * switch, React re-render) doesn't tear down and rebuild the subscription.
 */
export function useLspStatus(): { status: LspStatus; loading: boolean } {
  const status = useLspStore((s) => s.status);
  const loading = useLspStore((s) => s.loading);
  const setRefCount = useLspStore((s) => s.setRefCount);

  useEffect(() => {
    setRefCount((n) => n + 1);
    if (acquirePromise === null) {
      acquireSubscription();
    }
    return () => {
      setRefCount((n) => n - 1);
      queueMicrotask(releaseSubscription);
    };
  }, [setRefCount]);

  return { status, loading };
}
