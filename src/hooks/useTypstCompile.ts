import { useEffect, useTransition } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onCompiled, onConflict, onSaveStateChanged, onStatus } from "../lib/tauri";
import { useTabsStore } from "../store/tabsStore";
import { useSaveStateStore } from "../store/saveStateStore";

/**
 * App-level subscription to the typst compile lifecycle. Mount once near the
 * root; it wires `compiled` / `status` events into the stores.
 *
 * Diagnostics are now handled by the LSP server (tinymist) via
 * `publishDiagnostics`, not by the compile pipeline.
 *
 * Preview page updates (potentially large SVG payloads) are wrapped in
 * `startTransition` so React treats them as **low priority** — keystrokes and
 * other urgent updates flush first, and the preview re-render is deferred to
 * a gap in input activity.
 *
 * Also subscribes to `save_state_changed` (§5.3) and mirrors each transition
 * into `saveStateStore` so the status bar can show saving / save-failed.
 */
export function useTypstCompile(): void {
  const [, startTransition] = useTransition();

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let cancelled = false;

    (async () => {
      const uCompiled = await onCompiled((p) => {
        const tabs = useTabsStore.getState();
        // Wrap the SVG payload update in a transition so Monaco keystroke
        // processing is never blocked by preview reconciliation. The revision
        // guard inside setPages discards stale compiles (§7).
        startTransition(() => {
          tabs.setPages(p.id, p.revision, p.pages, p.lineMap);
        });
      });
      if (cancelled) {
        uCompiled();
        return;
      }
      unlistens.push(uCompiled);

      const uStatus = await onStatus((p) => {
        useTabsStore
          .getState()
          .setStatus(p.id, p.revision, p.status, p.durationMs);
      });
      if (cancelled) {
        uStatus();
        return;
      }
      unlistens.push(uStatus);

      // §5.4 / §8.4: external-modification conflict. Surface the backend's
      // conflict state on the tab and stash the disk content (present on
      // "modified") so the ConflictDialog can show a compare view without a
      // second IPC round-trip.
      const uConflict = await onConflict((p) => {
        useTabsStore.getState().setConflict(p.id, p.conflict, p.diskContent);
      });
      if (cancelled) {
        uConflict();
        return;
      }
      unlistens.push(uConflict);

      // §5.3: mirror save-state transitions into the store for the status bar.
      const uSave = await onSaveStateChanged((p) => {
        useSaveStateStore.getState().setSaveState(p.id, p.state);
      });
      if (cancelled) {
        uSave();
        return;
      }
      unlistens.push(uSave);
    })();

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [startTransition]);
}
