import { useEffect, useRef } from "react";
import { useLspStatus, type LspStatus } from "../store/lspStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { appLanguageClient } from "../components/Editor/appLanguageClient";

/**
 * React to a backend `WorkspaceChange` LSP restart by reconnecting
 * `appLanguageClient` against the fresh endpoint (spec §14.1 / §14.2 / §14.3).
 *
 * ## What this hook does
 *
 * When the backend restarts tinymist for a workspace open/close/switch, it
 * bumps the LSP generation, stamps `restartReason: "workspaceChange"` on the
 * `lsp_status` event, and publishes the new `wsUrl`. This hook watches the
 * `lspStore.status` transitions; on a transition INTO a status whose
 * `restartReason === "workspaceChange"`, it calls
 * `appLanguageClient.start({ wsUrl, workspaceRootPath, workspaceName })` so the
 * §7.1/§7.2 `initialize` is re-run against the new workspace and every open
 * model's `didOpen` auto-replays (the monaco model registry is the source —
 * already alive, so `DidOpenTextDocumentFeature.register()` at `start()` time
 * replays them per Task 4's verification).
 *
 * ## Phase-C gating (CRITICAL — read before changing)
 *
 * The wrapper-driven client (`buildLanguageClientConfig` in `lspClient.ts` +
 * the `languageClientConfig` prop on `MonacoEditor.tsx`) STILL drives the live
 * session today. `appLanguageClient` is built and correct but NOT YET the
 * active client — a later task rewires `MonacoEditor` to drop the wrapper.
 *
 * Until that rewire, this hook must NOT speculatively start `appLanguageClient`
 * on a workspace change: doing so would open a SECOND WebSocket to the backend,
 * and the backend's single-generation-single-connection rule (Task 6) means
 * whichever client connects first wins; the other is dropped — leaving the
 * wrapper's live session and `appLanguageClient` fighting.
 *
 * The hook is therefore gated on `appLanguageClient.isRunning()`: it only
 * triggers `start()` when SOMETHING ELSE has already started the singleton
 * (i.e. the rewire has happened, or a future caller opts in). Today nothing
 * starts it, so `isRunning()` is always `false` and this hook is an INERT
 * observer — it logs the workspace-change intent but takes no action. The new
 * code path stays present and unit-tested (see `shouldReconnectOnStatus`) so
 * the day the rewire lands, workspace-change reconnect just works.
 *
 * ## Decision helper
 *
 * The pure decision logic is extracted as [`shouldReconnectOnStatus`] so the
 * §14 contract is unit-testable without React / Tauri: it returns `true` iff
 * the transition is INTO a `workspaceChange`-reasoned status AND the caller
 * confirms `appLanguageClient` is currently running (the Phase-C gate).
 */
export function useLspWorkspaceReconnect(): void {
  // Use `useLspStatus()` (not the raw selector) so this hook participates in
  // the shared `lsp_status` subscription's refcount and is self-sufficient —
  // it doesn't silently rely on StatusBar/MonacoEditor to keep the
  // subscription alive.
  const { status } = useLspStatus();
  // Track the previous status so we only react on the TRANSITION into a
  // workspaceChange-reasoned status, not on every store tick. useRef (not
  // useState) so updating it doesn't itself trigger a re-render.
  const prevRef = useRef<LspStatus | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = status;

    const clientRunning = appLanguageClient.isRunning();
    if (shouldReconnectOnStatus(prev, status, clientRunning)) {
      // §14: reconnect against the new endpoint published with the bumped
      // generation. workspaceStore.rootPath/name drive the §7.1 (rooted) vs
      // §7.2 (null workspaceFolders) initialize. start() is idempotent for
      // identical params and serializes against any in-flight start/stop.
      const { rootPath, name } = useWorkspaceStore.getState();
      // eslint-disable-next-line no-console
      console.info(
        "[useLspWorkspaceReconnect] WorkspaceChange restart observed; " +
          "reconnecting appLanguageClient",
        { wsUrl: status.wsUrl, rootPath, name, generation: status.generation },
      );
      // Fire-and-forget: appLanguageClient serializes internally and never
      // rejects (failures surface via its `Failed` snapshot state).
      void appLanguageClient.start({
        wsUrl: status.wsUrl,
        workspaceRootPath: rootPath,
        workspaceName: name,
      });
    } else if (status.restartReason === "workspaceChange" && !clientRunning) {
      // Inert Phase-C log: the workspace change was observed, but the singleton
      // isn't running yet so we deliberately do NOT start it (see gating note
      // in the module doc). Logged so the intent is observable today.
      // eslint-disable-next-line no-console
      console.debug(
        "[useLspWorkspaceReconnect] WorkspaceChange restart observed but " +
          "appLanguageClient is not running; not reconnecting (Phase-C gate). " +
          "Generation",
        status.generation,
      );
    }
  }, [status]);
}

/**
 * Pure decision helper for §14: whether `useLspWorkspaceReconnect` should call
 * `appLanguageClient.start(...)` for a given `lspStore.status` transition.
 *
 * Returns `true` iff ALL of:
 *   1. `prev` is not the same object as `current` (a real transition — guards
 *      against the effect firing on an unchanged store read);
 *   2. `current.restartReason === "workspaceChange"` (this restart was
 *      triggered by a workspace open/close/switch, not a crash/manual restart);
 *   3. `clientRunning === true` (the Phase-C gate — the singleton is already
 *      the active client, so reconnecting is safe and won't open a second
 *      socket against the wrapper's session).
 *
 * Extracted as a free function so the §14 transition contract is unit-testable
 * without React, Tauri, or a live WebSocket.
 *
 * @param prev         The previous `lspStore.status` (null on first run).
 * @param current      The new `lspStore.status`.
 * @param clientRunning Whether `appLanguageClient.isRunning()` is true.
 */
export function shouldReconnectOnStatus(
  prev: LspStatus | null,
  current: LspStatus,
  clientRunning: boolean,
): boolean {
  // First mount (prev === null): no transition was OBSERVED, so don't act on a
  // workspaceChange reason that may have landed before this hook mounted. We
  // only reconnect on a transition we actually witness.
  if (prev === null) return false;
  // Same object reference → not a transition (the effect re-ran but the store
  // did not publish a new status).
  if (prev === current) return false;
  return current.restartReason === "workspaceChange" && clientRunning;
}
