import { create } from "zustand";
import { getTinymistInstall, onTinymistInstall } from "../lib/tauri";
import { createRefCountedSubscription } from "./refCountedSubscription";
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
//
// The subscription lifecycle (fetch once + listen once, ref-counted release)
// lives in `createRefCountedSubscription`; the backend broadcasts the same
// wire payload both as the command result and as the event, so `apply` stores
// the payload directly — no mapping layer.

const { useSubscription } = createRefCountedSubscription<TinymistInstallStatus>({
  fetch: getTinymistInstall,
  listen: (onEvent) => onTinymistInstall(onEvent),
  apply: (status) => useTinymistInstallStore.getState().setStatus(status),
  timeoutLabel: "get_tinymist_install timed out",
  setLoading: (loading) => useTinymistInstallStore.getState().setLoading(loading),
  setRefCount: (fn) => useTinymistInstallStore.getState().setRefCount(fn),
  getRefCount: () => useTinymistInstallStore.getState().refCount,
});

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
  useSubscription();

  return { status, loading };
}
