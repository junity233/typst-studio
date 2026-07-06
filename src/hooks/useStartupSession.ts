import { useEffect } from "react";
import { useTabsStore } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useRecoveryStore } from "../store/recoveryStore";
import { loadSession, restoreOpenDocuments } from "../lib/session";
import { openFileByPath, setDirty, onRecoveryAvailable } from "../lib/tauri";
import type { RecoveryAvailablePayload } from "../lib/types";

// Guards against StrictMode's double-invoke so the restore runs exactly once.
let startupDone = false;

/**
 * Maximum time (ms) to wait for the backend's `recovery_available` event before
 * proceeding with session restore (defensive fallback). The happy paths resolve
 * MUCH faster: a non-empty event (recovery offered) or an empty event (no
 * recovery) resolves the race immediately when it arrives; the backend emits at
 * ~+150ms after setup. This is only the ceiling for the rare case where no
 * event ever arrives (e.g. the listener registered too late, or the backend's
 * emit failed) — startup then proceeds without offering recovery.
 */
const RECOVERY_TIMEOUT_MS = 400;

/** Bounded upper limit (ms) for the dialog-close poll. */
const RECOVERY_DIALOG_POLL_MS = 50;
/** How many dialog-close polls before giving up (~10s) and proceeding anyway. */
const RECOVERY_DIALOG_MAX_POLLS = 200;

/**
 * Restore the full editing session on startup (design spec §13), coordinated
 * with crash recovery (§5.1.3): reopen every document that was open at
 * shutdown — disk files by path, untitled buffers by content — in their
 * original tab order, then re-activate the active view and re-mark dirty the
 * documents that were dirty.
 *
 * ## Recovery coordination (§5.1.3)
 *
 * Recovery is checked BEFORE normal session restore. The flow:
 *   1. Race a `recovery_available` listener against a short timeout. Resolve
 *      as soon as the event arrives (non-empty → recovery offered; empty/null
 *      → no recovery, proceed immediately), or after the timeout if no event
 *      arrives (defensive — proceed without recovery).
 *   2. If recovery is offered, wait for the user to resolve every snapshot
 *      (the dialog auto-closes once all are recovered/discarded) before
 *      restoring the session.
 *   3. Recovery data WINS over session for docs that have both: a snapshot has
 *      the unsaved content, so we SKIP the session's disk-reopen for any path
 *      that matches a recovered snapshot (the recovered doc is already open as
 *      a dirty in-memory tab).
 *
 * Restore order: workspace first (so disk files get workspace-relative
 * resolution), then disk files via the unified open path, then untitled
 * buffers, then activate, then re-mark dirty. Compile results and diagnostics
 * are NOT restored — they regenerate as each doc opens.
 *
 * The per-document replay loop lives in [`restoreOpenDocuments`] (testable in
 * isolation); this hook wires it to the store + IPC and adds the active-view
 * and dirty re-mark steps.
 *
 * Run once near the app root. Idempotent: a second invocation (e.g. StrictMode
 * remount) is a no-op. Recovery is per-document: a disk file that no longer
 * exists or is unreadable is skipped (with a warning) and does not block the
 * rest of the restore.
 */
export function useStartupSession(): void {
  useEffect(() => {
    if (startupDone) return;
    startupDone = true;

    void (async () => {
      const tabs = useTabsStore.getState().tabs;
      if (tabs.length > 0) return; // something already open (e.g. dev reload)
      try {
        await waitForRecoveryResolved();

        const session = await loadSession();
        if (session.openDocuments.length === 0) return; // nothing to restore

        // Recovery-vs-session coordination (§5.1.3): skip the session's
        // disk-reopen for any path that a recovered snapshot already covered.
        // The recovered docs are already open as dirty in-memory tabs; reusing
        // the session entry would reopen the (possibly stale) disk file.
        const recoveryState = useRecoveryStore.getState();
        const recoveredPaths = new Set(
          recoveryState.recoverable
            .filter((s) => recoveryState.recoveredIds.has(s.documentId))
            .map((s) => s.canonicalPath)
            .filter((p): p is string => typeof p === "string"),
        );

        // Workspace first (§13): hydrate is idempotent, so awaiting it here
        // (Workbench also kicks it off fire-and-forget) guarantees the open
        // workspace is set before disk files are reopened, giving them
        // workspace-relative #include resolution when possible.
        try {
          await useWorkspaceStore.getState().hydrate();
        } catch (e) {
          // Non-fatal: disk files fall back to loose-file resolution.
          console.warn("[startup] workspace hydrate failed:", e);
        }

        // Replay the document list, wiring each open to the store.
        const { restored, failures } = await restoreOpenDocuments(
          session.openDocuments,
          {
            openDisk: async (path) => {
              if (recoveredPaths.has(path)) {
                // Recovery already covered this path — skip the disk reopen.
                return null;
              }
              const doc = await openFileByPath(path);
              useTabsStore.getState().openPath(doc);
              return doc.id;
            },
            openUntitled: async (content) =>
              useTabsStore.getState().openTab(content),
          },
        );
        for (const f of failures) {
          const where =
            f.record.kind === "disk" ? f.record.path : "<untitled>";
          console.warn(
            `[startup] could not restore document (${where}):`,
            f.error,
          );
        }
        if (restored.length === 0) return;

        // Re-activate the active view, if it still resolves to a restored doc.
        // For untitled docs the id is reminted on restore, so an active id only
        // matches a disk-file record's restored id; otherwise fall back to the
        // last restored doc (matches the openPath/openTab default).
        const active = session.activeDocumentId;
        const match = active
          ? restored.find((r) => r.id === active)
          : undefined;
        const targetId = match ? match.id : restored[restored.length - 1].id;
        useTabsStore.getState().activate(targetId);

        // Re-mark dirty the documents that were dirty at shutdown. For a disk
        // file this signals "you had unsaved edits at shutdown that are now
        // lost" (the on-disk bytes were loaded); the user is alerted by the
        // dirty indicator. Best-effort per doc.
        for (const { id, dirty } of restored) {
          if (!dirty) continue;
          try {
            await setDirty(id, true);
            // Mirror the flag locally so the UI reflects it immediately. The
            // dirty flag is domain state, so it lives in documentsStore now.
            useDocumentsStore.getState().reMarkDirty(id);
          } catch (e) {
            console.warn(`[startup] could not re-mark ${id} dirty:`, e);
          }
        }
      } catch (e) {
        console.warn("[startup] session restore failed:", e);
      }
    })();
  }, []);
}

/**
 * Outcome of the recovery-available race: either recovery is being offered
 * (`Offered`) and the caller should wait for the dialog to close, or there is
 * nothing to recover (`None`) and the caller proceeds immediately.
 */
export type RecoveryRaceOutcome = "offered" | "none";

/**
 * Race the `recovery_available` event against a short timeout. Resolves as
 * soon as:
 *   - the event arrives with a NON-EMPTY list → `"offered"` (show the dialog),
 *   - the event arrives with an EMPTY/null list → `"none"` (proceed now), OR
 *   - the timeout elapses with no event → `"none"` (proceed defensively).
 *
 * Pure over its injectable dependencies so it is unit-testable with fake
 * timers and a stub subscribe (no Tauri runtime required). The production
 * caller wires `onRecoveryAvailable`; the test wires a controllable stub.
 *
 * Contract: `subscribe` registers a handler and returns an `unlisten` (matching
 * `onRecoveryAvailable`). The handler is invoked at most once meaningfully;
 * once the race resolves, the listener is torn down.
 *
 * @param subscribe  register the one-shot recovery_available listener
 * @param timeoutMs  defensive ceiling before proceeding without recovery
 */
export async function raceRecoveryAvailable(
  subscribe: (
    handler: (payload: RecoveryAvailablePayload) => void,
  ) => Promise<() => void>,
  timeoutMs: number = RECOVERY_TIMEOUT_MS,
): Promise<RecoveryRaceOutcome> {
  // Fast path: the store may already hold a recoverable list if the event
  // landed (and App.tsx populated the store) before this race even started.
  // In that case there's nothing to wait for — the dialog is already open.
  if (useRecoveryStore.getState().recoverable.length > 0) {
    return "offered";
  }

  return new Promise<RecoveryRaceOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;

    const finish = (outcome: RecoveryRaceOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unlisten?.();
      resolve(outcome);
    };

    // Defensive ceiling: if no event arrives in time, proceed without recovery
    // (a missing event means no recovery will be offered).
    timer = setTimeout(() => finish("none"), timeoutMs);

    // The listener resolves the race as soon as the event lands. A non-empty
    // list means recovery is offered (the dialog will open); an empty/null list
    // means there's nothing to recover → proceed immediately.
    void subscribe((payload) => {
      const snapshots = payload?.snapshots;
      finish(snapshots != null && snapshots.length > 0 ? "offered" : "none");
    }).then((fn) => {
      // If the race already resolved (timeout fired first), tear down the
      // listener we just registered. Otherwise stash it for later teardown.
      if (settled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
  });
}

/**
 * Wait for crash-recovery to be resolved before session restore proceeds
 * (§5.1.3).
 *
 * - Race a `recovery_available` listener against a short timeout. If the event
 *   arrives (non-empty → offered; empty → none) the race resolves immediately;
 *   if no event arrives within the window we assume there's nothing to recover
 *   and proceed. This keeps the no-recovery startup path from paying the old
 *   unconditional 1500ms delay.
 * - If recovery IS offered, wait (polling the recovery store) until the dialog
 *   has closed (every snapshot recovered or discarded) before returning.
 *
 * The actual event subscription + store population also lives in `App.tsx`;
 * this function subscribes its own one-shot listener for the race and reads
 * the resulting store state.
 */
async function waitForRecoveryResolved(): Promise<void> {
  const outcome = await raceRecoveryAvailable(onRecoveryAvailable);
  if (outcome === "none") return; // nothing to recover → proceed immediately

  // Recovery offered: poll until the dialog closes (every snapshot decided).
  for (let i = 0; i < RECOVERY_DIALOG_MAX_POLLS; i++) {
    const { dialogOpen } = useRecoveryStore.getState();
    if (!dialogOpen) return;
    await sleep(RECOVERY_DIALOG_POLL_MS);
  }
  // Bounded fallback: if the dialog is somehow stuck open after ~10s, proceed
  // anyway so startup is never permanently blocked. Recovery decisions can
  // still be made later via the recovered docs in the tabs.
  console.warn("[startup] recovery dialog did not close in time; proceeding with session restore");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

