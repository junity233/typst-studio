import { create } from "zustand";
import { getLspStatus, onLspStatus } from "../lib/tauri";
import { appLanguageClient } from "../components/Editor/appLanguageClient";
import { createRefCountedSubscription } from "./refCountedSubscription";
import type {
  LspStatusPayload,
  LspStatusKind,
  LspRestartReason,
} from "../lib/types";

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
 *
 * The shape mirrors the wire `LspStatusPayload` (the generated `types.ts` is
 * authoritative). The store holds it directly so consumers (StatusBar) read
 * `statusKind`, `restartReason`, and `message` without a second mapping layer.
 */
export interface LspStatus {
  available: boolean;
  enabled: boolean;
  statusKind: LspStatusKind;
  generation: number;
  wsUrl: string;
  /** §6.4: present only on events that announce a generation bump caused by a
   * restart/crash; `null` otherwise. */
  restartReason: LspRestartReason | null;
  /** §6.4: optional human-readable hint (e.g. the `Failed` message). */
  message: string | null;
}

interface LspStoreState {
  status: LspStatus;
  loading: boolean;
  /**
   * LSP generation (spec §6.4 / §16). Task 7: the wire `lsp_status` payload
   * now carries `generation`, so this is driven by the wire (forward-only via
   * `shouldAcceptStatusEvent`). The `appLanguageClient` singleton still bumps
   * its own generation on client reconnect and mirrors here as a secondary
   * feed — both should converge on the same number for a healthy session.
   * Consumers (the diagnostics bridge) read this to drop data belonging to a
   * dead generation. Defaults to 0; only ever moves forward.
   */
  generation: number;
  /** Bumped by each subscriber; the subscription is held while > 0. */
  refCount: number;
  /** Internal: set by the store actions, not by callers. */
  setStatus: (s: LspStatus) => void;
  setLoading: (b: boolean) => void;
  /** Record the current LSP generation. Forward-only. */
  setGeneration: (n: number) => void;
  setRefCount: (fn: (n: number) => number) => void;
}

const OFFLINE: LspStatus = {
  available: false,
  enabled: false,
  statusKind: "disabled",
  generation: 0,
  wsUrl: "",
  restartReason: null,
  message: null,
};

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
 * dropped.
 */
export function shouldAcceptStatusEvent(
  eventGeneration: number,
  currentGeneration: number,
): boolean {
  return eventGeneration >= currentGeneration;
}

/**
 * Map a wire `LspStatusPayload` to the store's internal `LspStatus`. Single
 * mapping point: the only field rename is `status` → `statusKind` (the wire
 * field is `status`; the store spells the discriminator `statusKind` so it
 * doesn't shadow the `status` slot on other store slices). `restartReason` /
 * `message` arrive as `T | null | undefined` on the wire and normalize to
 * `T | null` internally.
 */
export function payloadToStatus(p: LspStatusPayload): LspStatus {
  return {
    available: p.available,
    enabled: p.enabled,
    statusKind: p.status,
    generation: p.generation,
    wsUrl: p.wsUrl,
    restartReason: p.restartReason ?? null,
    message: p.message ?? null,
  };
}

// --- the single shared subscription -----------------------------------------
//
// The subscription is established lazily and shared across all readers (the
// fetch-once + listen-once lifecycle lives in `createRefCountedSubscription`).

/**
 * Apply a wire `LspStatusPayload` to the store, honoring the §6.4 generation
 * gate: an event whose `generation` is strictly less than the store's current
 * generation is dropped (a stale event from a superseded connection must not
 * clobber the live view). When accepted, both the status and the store's
 * top-level `generation` advance (the latter forward-only via `setGeneration`).
 */
export function applyPayload(p: LspStatusPayload): void {
  const store = useLspStore.getState();
  if (!shouldAcceptStatusEvent(p.generation, store.generation)) {
    return;
  }
  store.setGeneration(p.generation);
  store.setStatus(payloadToStatus(p));
}

const { useSubscription: useLspSubscription } =
  createRefCountedSubscription<LspStatusPayload>({
    fetch: getLspStatus,
    listen: (onEvent) => onLspStatus(onEvent),
    apply: applyPayload,
    timeoutLabel: "get_lsp_status timed out",
    setLoading: (loading) => useLspStore.getState().setLoading(loading),
    setRefCount: (fn) => useLspStore.getState().setRefCount(fn),
    getRefCount: () => useLspStore.getState().refCount,
  });

// --- generation mirror (appLanguageClient → lspStore) -----------------------
//
// §6.4 / §16: Task 7 makes the wire `lsp_status` payload the PRIMARY source of
// the LSP generation (`payload.generation`, applied via `applyPayload` above).
// The `appLanguageClient` singleton still bumps its OWN generation on every
// `start()`-of-a-new-client (restart / reconnect) and we mirror it here as a
// SECONDARY feed so the store's generation stays live even before the first
// wire event arrives (e.g. before the status subscription is established) and
// tracks client-side reconnects that haven't yet produced a wire event. Both
// feeds are forward-only (`setGeneration`), so they converge on the same
// number for a healthy session; in the rare case they diverge transiently the
// higher wins.
//
// The mirror is installed ONCE at module load (not ref-counted with the status
// subscription). `appLanguageClient.subscribe` is cheap and never throws — it
// just adds to a Set — so an always-on module-level listener keeps
// `lspStore.generation` live even before any React reader mounts. This matters
// for module-level event handlers (the diagnostics bridge) that gate on the
// generation independently of the UI. We seed with the current generation first
// so the store isn't stuck at 0 if the client had already bumped before this
// module loaded (it won't in practice, but the seed is free).

useLspStore.getState().setGeneration(appLanguageClient.getGeneration());
appLanguageClient.subscribe((snap) => {
  useLspStore.getState().setGeneration(snap.generation);
});

/**
 * Read LSP status with a single shared subscription. Mount this in any
 * component that needs `status`, `loading`, or `generation`; the subscription
 * is ref-counted so it stays alive while at least one reader is mounted (the
 * lifecycle lives in `createRefCountedSubscription`). The generation mirror is
 * installed once at module load (see the `appLanguageClient.subscribe` block
 * above) and is NOT ref-counted — it stays live for the process lifetime so
 * module-level consumers (e.g. the diagnostics bridge) can gate on the
 * generation independent of any React reader being mounted.
 */
export function useLspStatus(): {
  status: LspStatus;
  loading: boolean;
  generation: number;
} {
  const status = useLspStore((s) => s.status);
  const loading = useLspStore((s) => s.loading);
  const generation = useLspStore((s) => s.generation);
  useLspSubscription();

  return { status, loading, generation };
}
