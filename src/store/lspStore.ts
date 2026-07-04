import { useEffect } from "react";
import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { onLspStatus } from "../lib/tauri";
import { appLanguageClient } from "../components/Editor/appLanguageClient";

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
  /** §6.3: true while the accept loop is in backoff after a fatal listener
   * error (waiting to retry). The StatusBar shows a "Reconnecting…" indicator. */
  reconnecting: boolean;
}

interface LspStoreState {
  status: LspStatus;
  loading: boolean;
  /**
   * LSP generation (spec §6.4 / §16). The wire `lsp_status` payload does NOT
   * carry a generation yet (Task 7 adds it); for Task 5 generation is threaded
   * through the `appLanguageClient` singleton — it bumps on every restart /
   * reconnect that constructs a new client. Consumers (the diagnostics bridge,
   * future generation-aware event handlers) read this to drop data belonging
   * to a dead generation. Defaults to 0; only ever moves forward.
   */
  generation: number;
  /** Bumped by each subscriber; the subscription is held while > 0. */
  refCount: number;
  /** Internal: set by the store actions, not by callers. */
  setStatus: (s: LspStatus) => void;
  setLoading: (b: boolean) => void;
  /** Record the current LSP generation (from `appLanguageClient`). Forward-only. */
  setGeneration: (n: number) => void;
  setRefCount: (fn: (n: number) => number) => void;
}

const OFFLINE: LspStatus = { running: false, wsUrl: "", available: false, reconnecting: false };

export const useLspStore = create<LspStoreState>((set) => ({
  status: OFFLINE,
  loading: true,
  generation: 0,
  refCount: 0,
  setStatus: (s) => set({ status: s }),
  setLoading: (b) => set({ loading: b }),
  // Forward-only: a stale generation value (e.g. an out-of-order notification)
  // must NOT rewind the marker consumers use to drop stale data.
  setGeneration: (n) =>
    set((s) => (n > s.generation ? { generation: n } : s)),
  setRefCount: (fn) =>
    set((state) => ({ refCount: Math.max(0, fn(state.refCount)) })),
}));

/**
 * Pure generation-gate for incoming `lsp_status` events (spec §6.4 "前端只接受
 * 不小于当前 generation 的状态事件"). Returns `true` when an event tagged with
 * `eventGeneration` should be ACCEPTED against the store's `currentGeneration`,
 * `false` when it is stale and must be dropped.
 *
 * Boundary: an event whose generation EQUALS the current one is accepted (it is
 * a refresh of the same generation, not stale). Only a strictly-older event is
 * dropped. Until Task 7 threads a generation field onto the wire payload,
 * callers that don't have an event generation pass the store's current
 * generation (always accepted) — the helper exists now so the gate is in place
 * the moment the payload carries it.
 */
export function shouldAcceptStatusEvent(
  eventGeneration: number,
  currentGeneration: number,
): boolean {
  return eventGeneration >= currentGeneration;
}

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

// --- generation mirror (appLanguageClient → lspStore) -----------------------
//
// §6.4 / §16: the wire `lsp_status` payload does not yet carry a generation
// field (Task 7). For Task 5, the LSP generation is owned by the
// `appLanguageClient` singleton — it bumps on every start()-of-a-new-client
// (restart / reconnect). We mirror that number into the store here so any
// consumer with access to the store (the diagnostics bridge, future event
// handlers) can drop stale per-generation data.
//
// The mirror is installed ONCE at module load (not ref-counted with the status
// subscription). `appLanguageClient.subscribe` is cheap and never throws — it
// just adds to a Set — so an always-on module-level listener keeps
// `lspStore.generation` live even before any React reader mounts. This matters
// for module-level event handlers (Task 6/11) that gate on the generation
// independently of the UI. We seed with the current generation first so the
// store isn't stuck at 0 if the client had already bumped before this module
// loaded (it won't in practice, but the seed is free).

useLspStore.getState().setGeneration(appLanguageClient.getGeneration());
appLanguageClient.subscribe((snap) => {
  useLspStore.getState().setGeneration(snap.generation);
});

/**
 * Read LSP status with a single shared subscription. Mount this in any
 * component that needs `status`, `loading`, or `generation`; the subscription
 * is ref-counted so it stays alive while at least one reader is mounted.
 *
 * Lifecycle: the first mount triggers `acquireSubscription()` (fetch + listen,
 * memoized so concurrent mounters share one operation) AND
 * `acquireGenerationMirror()` (an `appLanguageClient.subscribe` listener that
 * records generation bumps). Each mount bumps `refCount`; cleanup decrements
 * it. When it reaches zero we release both, but the release is deferred to a
 * microtask so a synchronous unmount+remount (tab switch, React re-render)
 * doesn't tear down and rebuild the subscription.
 */
export function useLspStatus(): {
  status: LspStatus;
  loading: boolean;
  generation: number;
} {
  const status = useLspStore((s) => s.status);
  const loading = useLspStore((s) => s.loading);
  const generation = useLspStore((s) => s.generation);
  const setRefCount = useLspStore((s) => s.setRefCount);

  useEffect(() => {
    setRefCount((n) => n + 1);
    if (acquirePromise === null) {
      acquireSubscription();
    }
    // The generation mirror is installed once at module load (see above), so
    // there's nothing to acquire/release per-reader here.
    return () => {
      setRefCount((n) => n - 1);
      queueMicrotask(() => {
        releaseSubscription();
      });
    };
  }, [setRefCount]);

  return { status, loading, generation };
}
