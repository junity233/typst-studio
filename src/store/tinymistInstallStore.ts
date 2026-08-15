import { useEffect } from "react";
import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getTinymistInstall, onTinymistInstall } from "../lib/tauri";
import type { TinymistInstallStatus } from "../lib/types";

/**
 * Managed tinymist install status (auto-download into ~/.typststudio/),
 * shared app-wide via a single subscription — same pattern as `lspStore`:
 * the first reader triggers one `get_tinymist_install` fetch + one
 * `tinymist_install` event listener; all readers share the state.
 *
 * The backend broadcasts the same wire payload (`TinymistInstallStatus`)
 * both as the command result and as the event, so no mapping layer is
 * needed — the store holds the payload directly.
 */

interface TinymistInstallStoreState {
  status: TinymistInstallStatus | null;
  /** True until the initial fetch resolves (or times out). */
  loading: boolean;
  /** Bumped by each subscriber; the subscription is held while > 0. */
  refCount: number;
  setStatus: (s: TinymistInstallStatus) => void;
  setLoading: (b: boolean) => void;
  setRefCount: (fn: (n: number) => number) => void;
}

export const useTinymistInstallStore = create<TinymistInstallStoreState>(
  (set) => ({
    status: null,
    loading: true,
    refCount: 0,
    setStatus: (status) => set({ status }),
    setLoading: (loading) => set({ loading }),
    setRefCount: (fn) =>
      set((state) => ({ refCount: Math.max(0, fn(state.refCount)) })),
  }),
);

/**
 * Download progress as a 0..100 percentage, or `null` when not applicable
 * (not downloading, or the total size is still unknown).
 */
export function downloadPercent(status: TinymistInstallStatus): number | null {
  if (status.state !== "downloading" || status.totalBytes <= 0) return null;
  return Math.min(
    100,
    Math.floor((status.receivedBytes / status.totalBytes) * 100),
  );
}

// --- the single shared subscription -----------------------------------------

let acquirePromise: Promise<UnlistenFn> | null = null;

function acquireSubscription(): Promise<UnlistenFn> {
  if (acquirePromise !== null) return acquirePromise;

  acquirePromise = (async () => {
    try {
      const initial = await Promise.race<TinymistInstallStatus>([
        getTinymistInstall(),
        new Promise<TinymistInstallStatus>((_, reject) =>
          setTimeout(
            () => reject(new Error("get_tinymist_install timed out")),
            5000,
          ),
        ),
      ]);
      useTinymistInstallStore.getState().setStatus(initial);
    } catch {
      // ignore — the event subscription catches up.
    } finally {
      useTinymistInstallStore.getState().setLoading(false);
    }
    return onTinymistInstall((p) =>
      useTinymistInstallStore.getState().setStatus(p),
    );
  })();

  acquirePromise.catch(() => {
    acquirePromise = null;
  });

  return acquirePromise;
}

function releaseSubscription(): void {
  if (
    useTinymistInstallStore.getState().refCount === 0 &&
    acquirePromise !== null
  ) {
    const pending = acquirePromise;
    acquirePromise = null;
    void pending.then(
      (unlisten) => unlisten(),
      () => {},
    );
  }
}

/**
 * Read the tinymist install status with a single shared subscription.
 * Mirrors `useLspStatus`: lazy acquire on first mount, ref-counted release.
 */
export function useTinymistInstall(): {
  status: TinymistInstallStatus | null;
  loading: boolean;
} {
  const status = useTinymistInstallStore((s) => s.status);
  const loading = useTinymistInstallStore((s) => s.loading);
  const setRefCount = useTinymistInstallStore((s) => s.setRefCount);

  useEffect(() => {
    setRefCount((n) => n + 1);
    if (acquirePromise === null) {
      acquireSubscription();
    }
    return () => {
      setRefCount((n) => n - 1);
      queueMicrotask(() => {
        releaseSubscription();
      });
    };
  }, [setRefCount]);

  return { status, loading };
}
