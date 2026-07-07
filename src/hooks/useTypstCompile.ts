import { useEffect, useTransition } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onCompiled,
  onConflict,
  onDiagnostics,
  onDocsRebound,
  onSaveStateChanged,
  onStatus,
} from "../lib/tauri";
import { markCommitted, markReceived } from "../lib/compileTiming";
import { useTabsStore } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useSaveStateStore } from "../store/saveStateStore";
import { useDiagnosticsStore } from "../store/diagnosticsStore";
import { useConflictDialogStore } from "../store/conflictDialogStore";

/**
 * App-level subscription to the typst compile lifecycle. Mount once near the
 * root; it wires `compiled` / `status` events into the stores.
 *
 * Compile-error **reasons**: the backend emits a `diagnostics` event carrying
 * the full Typst diagnostic list (message + position) on every compile — empty
 * on success (clears stale errors), populated on failure. We subscribe here and
 * write it into the `diagnosticsStore` `compiler` slot so the Problems panel
 * surfaces WHY a compile failed, not just that it did. This complements (and is
 * deduplicated against) tinymist's LSP `publishDiagnostics` path, which fills
 * the `tinymist` slot. When the LSP is offline (crash/restart window), the
 * compiler slot keeps compile errors visible.
 *
 * Preview page updates (potentially large SVG payloads) are wrapped in
 * `startTransition` so React treats them as **low priority** — keystrokes and
 * other urgent updates flush first, and the preview re-render is deferred to a
 * gap in input activity.
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
        // DIAGNOSTIC: mark the instant the compiled event arrived in JS (end of
        // ⑦ IPC transfer + ⑧ deserialize). See src/lib/compileTiming.ts.
        markReceived(p.revision, p.pageCount, p.durationMs);
        const tabs = useTabsStore.getState();
        // Wrap the SVG payload update in a transition so Monaco keystroke
        // processing is never blocked by preview reconciliation. The revision
        // guard inside setPages discards stale compiles (§7). setPages merges
        // incrementally: unchanged pages keep their SVG string reference, so
        // SvgPage's memo skips blob rebuild.
        startTransition(() => {
          tabs.setPages(
            p.id,
            p.revision,
            p.pageCount,
            p.full,
            p.changedPages,
            p.lineMap,
            p.outline,
          );
          // DIAGNOSTIC: record when setPages actually committed inside the
          // transition (⑨ transition lag).
          markCommitted(p.revision);
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

      // Compile diagnostics: the backend emits the Typst diagnostic list on
      // every compile (empty on success → clears stale errors; populated on
      // failure → surfaces the error reason). §7 revision guard: drop events
      // whose revision is strictly older than the doc's current revision so a
      // slow compile of an older buffer can't clobber newer diagnostics.
      const uDiag = await onDiagnostics((p) => {
        const doc = useDocumentsStore.getState().documents[p.id];
        if (!doc) return;
        if (p.revision < doc.revision) return;
        useDiagnosticsStore.getState().set(p.id, "compiler", p.diagnostics);
      });
      if (cancelled) {
        uDiag();
        return;
      }
      unlistens.push(uDiag);

      // §5.4 / §8.4: external-modification conflict. Surface the backend's
      // conflict state on the tab and stash the disk content (present on
      // "modified") so the ConflictDialog can show a compare view without a
      // second IPC round-trip. Any external change (clean or dirty buffer) now
      // surfaces as a conflict — open the dialog so the user can decide whether
      // to apply the disk content, rather than silently reloading.
      const uConflict = await onConflict((p) => {
        useTabsStore.getState().setConflict(p.id, p.conflict, p.diskContent);
        if (p.conflict !== "none") {
          const dlg = useConflictDialogStore.getState();
          // Don't re-open if this doc's dialog is already up (e.g. the user is
          // reviewing the compare view, or dismissed it with "Later"); the
          // StatusBar "Conflict" entry remains a manual re-entry point.
          if (dlg.openForId !== p.id) {
            dlg.open(p.id);
          }
        }
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

      // §6.4: a rename/move rebound open docs to new paths. Mirror the new path
      // into the documents store so tab titles / breadcrumbs / active-file
      // highlight track the rename. (The buffer, dirty, and revision are
      // unchanged — only the disk location moved.)
      const uRebound = await onDocsRebound((p) => {
        for (const d of p.docs) {
          useDocumentsStore.getState().rebindDocPath(d.id, d.newPath);
        }
      });
      if (cancelled) {
        uRebound();
        return;
      }
      unlistens.push(uRebound);
    })();

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [startTransition]);
}
