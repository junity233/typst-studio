import { useEffect } from "react";
import { useTabsStore } from "../store/tabsStore";
import { loadSession } from "../lib/session";
import { openFileByPath } from "../lib/tauri";

// Guards against StrictMode's double-invoke so the restore runs exactly once.
let startupDone = false;

/**
 * Restore the last-opened file on startup. If a remembered file exists and is
 * still reachable, reopen it; otherwise start with no tab open (the user
 * creates one via the + button or by opening a file).
 *
 * Run once near the app root. Idempotent: a second invocation (e.g. StrictMode
 * remount) is a no-op. A failed reopen (file moved/deleted) is silently
 * ignored — losing the hint is harmless.
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
        if (session.lastFile) {
          const doc = await openFileByPath(session.lastFile);
          useTabsStore.getState().openPath(doc);
        }
      } catch (e) {
        console.warn("[startup] last-file restore failed:", e);
      }
    })();
  }, []);
}
