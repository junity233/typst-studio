import { useEffect, useRef } from "react";
import { useLspStatus, type LspStatus } from "../store/lspStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { appLanguageClient } from "../components/Editor/appLanguageClient";

/**
 * React to a backend LSP generation bump by reconnecting `appLanguageClient`
 * against the fresh endpoint (spec §14.1 / §14.2 / §14.3 / §6.3 childCrash).
 *
 * ## What this hook does
 *
 * When the backend bumps the LSP generation it publishes a `lsp_status` event
 * carrying the new `wsUrl` and a `restartReason` explaining the bump:
 *
 *   - `workspaceChange` — workspace open/close/switch (Task 8). The new root
 *     must drive the §7.1 (rooted) vs §7.2 (null workspaceFolders) initialize,
 *     so the workspaceStore's current `rootPath`/`name` are passed through.
 *   - `childCrash` — tinymist exited unexpectedly. The workspace did NOT
 *     change, so we must re-`initialize` against the SAME workspace that was
 *     active when the crash happened (NOT necessarily workspaceStore's current
 *     value — the user could have a loose-file-only session). Reusing the
 *     singleton's last-started params preserves the rooting.
 *   - `settingsChange` / `manual` / `relayError` / `generationMismatch` — same
 *     as `childCrash`: re-initialize against the prior workspace params.
 *
 * This hook watches `lspStore.status` transitions; on a transition INTO a status
 * whose generation is STRICTLY NEWER than the one we last acted on (a real
 * generation advance — guards against duplicate/no-op events), it calls
 * `appLanguageClient.start(...)` so the §7.1/§7.2 `initialize` re-runs and
 * every open model's `didOpen` auto-replays.
 *
 * ## Gating on `appLanguageClient.everStartedSuccessfully()`
 *
 * The hook must NOT speculatively start the client before the primary
 * `start()` (from `MonacoEditor`, once the editor runtime + LSP endpoint are
 * ready) has completed and reached Ready at least once — the backend's
 * single-generation-single-connection rule (Task 6) means whichever client
 * connects first wins; a racing second client would be dropped.
 *
 * The gate is therefore [`everStartedSuccessfully`](Self.everStartedSuccessfully)
 * (sticky "any client ever reached Ready"), NOT `isRunning()`. This matters for
 * the `childCrash` case: by the time the backend publishes the crash-bumped
 * generation the singleton has already left `Running` (so `isRunning()` is
 * false), but it has run before — so reconnecting is safe and correct. Before
 * the first Ready, the hook is an inert observer: it logs the intent but takes
 * no action.
 *
 * ## Decision helper
 *
 * The pure decision logic is extracted as [`shouldReconnectOnStatus`] so the
 * contract is unit-testable without React / Tauri: it returns `true` iff the
 * transition is INTO a status with a STRICTLY NEWER generation AND the caller
 * confirms `appLanguageClient` has ever reached Ready (the gate).
 */
export function useLspWorkspaceReconnect(): void {
  // Use `useLspStatus()` (not the raw selector) so this hook participates in
  // the shared `lsp_status` subscription's refcount and is self-sufficient —
  // it doesn't silently rely on StatusBar/MonacoEditor to keep the
  // subscription alive.
  const { status } = useLspStatus();
  // Track the previous status so we only react on the TRANSITION into a
  // newer-generation status, not on every store tick. useRef (not useState) so
  // updating it doesn't itself trigger a re-render.
  const prevRef = useRef<LspStatus | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = status;

    const everStarted = appLanguageClient.everStartedSuccessfully();
    if (shouldReconnectOnStatus(prev, status, everStarted)) {
      // A generation advance means the OLD endpoint is invalid; reconnect
      // against the new wsUrl. For a workspaceChange the workspaceStore's
      // current rootPath/name drive the §7.1 vs §7.2 initialize. For any OTHER
      // reason (childCrash / settingsChange / …) the workspace did NOT change,
      // so appLanguageClient.startWithFreshEndpoint() re-initializes against
      // the SAME workspace params captured from the last start() (preserving
      // the rooting the crash interrupted). start() serializes against any
      // in-flight start/stop and never rejects (failures surface via its
      // `Failed` snapshot state).
      const { rootPath, name } = useWorkspaceStore.getState();
      // eslint-disable-next-line no-console
      console.info(
        "[useLspWorkspaceReconnect] generation advance observed; " +
          "reconnecting appLanguageClient",
        {
          wsUrl: status.wsUrl,
          restartReason: status.restartReason,
          rootPath,
          name,
          generation: status.generation,
          workspaceChange: status.restartReason === "workspaceChange",
        },
      );
      // Fire-and-forget: appLanguageClient serializes internally and never
      // rejects (failures surface via its `Failed` snapshot state).
      void appLanguageClient.startWithFreshEndpoint(
        status.wsUrl,
        // Only a workspaceChange switches the rooting; every other reason
        // reuses the prior workspace params.
        status.restartReason === "workspaceChange"
          ? { workspaceRootPath: rootPath, workspaceName: name }
          : null,
      );
    } else if (status.generation > 0 && !everStarted) {
      // Inert gate log: a generation advance was observed, but the singleton
      // has never reached Ready yet so we deliberately do NOT start it (see
      // gating note in the module doc). Logged so the intent is observable.
      // eslint-disable-next-line no-console
      console.debug(
        "[useLspWorkspaceReconnect] generation advance observed but " +
          "appLanguageClient has never reached Ready; not reconnecting " +
          "(waiting for the primary start from MonacoEditor). Generation",
        status.generation,
      );
    }
  }, [status]);
}

/**
 * Pure decision helper: whether `useLspWorkspaceReconnect` should call
 * `appLanguageClient.start(...)` for a given `lspStore.status` transition.
 *
 * Returns `true` iff ALL of:
 *   1. `prev` is not the same object as `current` (a real transition — guards
 *      against the effect firing on an unchanged store read);
 *   2. `current.generation` is strictly greater than `prev.generation` (a real
 *      generation advance — the only events that mint a fresh endpoint worth
 *      reconnecting to). This covers `workspaceChange`, `childCrash`,
 *      `settingsChange`, `manual`, `relayError`, and `generationMismatch`;
 *   3. `clientEverStarted === true` (the gate — the singleton has reached Ready
 *      at least once, so reconnecting is safe and won't open a second socket
 *      before the primary `start()` from MonacoEditor owns the live session).
 *
 * Extracted as a free function so the transition contract is unit-testable
 * without React, Tauri, or a live WebSocket.
 *
 * @param prev              The previous `lspStore.status` (null on first run).
 * @param current           The new `lspStore.status`.
 * @param clientEverStarted Whether `appLanguageClient.everStartedSuccessfully()`
 *                          is true (sticky "any client reached Ready").
 */
export function shouldReconnectOnStatus(
  prev: LspStatus | null,
  current: LspStatus,
  clientEverStarted: boolean,
): boolean {
  // First mount (prev === null): no transition was OBSERVED, so don't act on a
  // generation advance that may have landed before this hook mounted. We only
  // reconnect on an advance we actually witness.
  if (prev === null) return false;
  // Same object reference → not a transition (the effect re-ran but the store
  // did not publish a new status).
  if (prev === current) return false;
  // Only a STRICTLY newer generation mints a fresh endpoint worth connecting
  // to. Equal-generation refreshes (e.g. a steady-state Running re-publish
  // carrying the same generation) carry no new URL.
  if (current.generation <= prev.generation) return false;
  return clientEverStarted;
}
