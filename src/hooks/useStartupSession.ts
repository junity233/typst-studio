import { useEffect } from "react";
import { useTabsStore } from "../store/tabsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { loadSession, restoreOpenDocuments } from "../lib/session";
import { openFileByPath, setDirty } from "../lib/tauri";

// Guards against StrictMode's double-invoke so the restore runs exactly once.
let startupDone = false;

/**
 * Restore the full editing session on startup (design spec §13): reopen every
 * document that was open at shutdown — disk files by path, untitled buffers by
 * content — in their original tab order, then re-activate the active view and
 * re-mark dirty the documents that were dirty.
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
      const { tabs } = useTabsStore.getState();
      if (tabs.length > 0) return; // something already open (e.g. dev reload)
      try {
        const session = await loadSession();
        if (session.openDocuments.length === 0) return; // nothing to restore

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
            // Mirror the flag locally so the UI reflects it immediately.
            useTabsStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === id ? { ...t, dirty: true } : t,
              ),
            }));
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
