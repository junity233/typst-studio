import { useTransition } from "react";
import {
  onCompiled,
  onConflict,
  onDiagnostics,
  onDocsRebound,
  onSaveStateChanged,
  onStatus,
} from "../lib/tauri";
import type { ConflictPayload } from "../lib/types";
import { markCommitted, markReceived } from "../lib/compileTiming";
import { useTabsStore } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useSaveStateStore } from "../store/saveStateStore";
import { useDiagnosticsStore } from "../store/diagnosticsStore";
import { useConflictDialogStore } from "../store/conflictDialogStore";
import { useTauriListener } from "./useTauriListener";

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
 *
 * Every listener is registered through `useTauriListener`, which closes the
 * unmount/unlisten race AND isolates registration failures: a rejected `onX`
 * promise is console.error'd with its source name instead of aborting the
 * remaining subscriptions as an unhandled rejection.
 */
/**
 * Whether a conflict on `id` should surface a modal dialog. Two gates:
 *
 * 1. `exists` — the doc must still be present in `documentsStore`. The delete
 *    flow's invoke response and the watcher's conflict event are independent
 *    IPCs, so the later arrival can reference a doc already removed from every
 *    store; opening a dialog (or even recording state) for a dead id would
 *    leave a dangling `conflictDialogStore.openForId`.
 * 2. `hidden` — soft-closed docs don't get a popup either; the user isn't
 *    looking at them, so a modal prompt for a "closed" file is noise. The
 *    conflict state is still recorded into the store regardless, so
 *    reactivating the tab surfaces it via the StatusBar "Conflict" entry.
 *
 * Pure + exported for unit-testing the surfacing policy.
 */
export function shouldSurfaceConflictDialog(
  id: string,
  hidden: ReadonlyArray<string>,
  exists: boolean,
): boolean {
  return exists && !hidden.includes(id);
}

/**
 * Handle one `conflict` backend event (§5.4 / §8.4). Exported so the
 * delete-race / hidden-doc / dedup behavior is unit-testable against the real
 * stores instead of only via the pure policy above.
 *
 * Order matters: the existence gate runs BEFORE `setConflict` — an event for a
 * removed doc must not write conflict state for a dead id at all.
 */
export function handleConflictEvent(p: ConflictPayload): void {
  const exists = p.id in useDocumentsStore.getState().documents;
  // Delete race: the backend's delete response and the watcher's conflict
  // event are separate IPCs; the later arrival can target a doc that was
  // already removed from every store. Drop it entirely — recording state or
  // opening the dialog would leave orphaned entries nothing will ever clean.
  if (!exists) return;
  useTabsStore.getState().setConflict(p.id, p.conflict, p.diskContent);
  if (p.conflict === "none") return;
  // Don't pop the dialog for soft-closed (hidden) docs: the user isn't looking
  // at them, so a modal prompt for a "closed" file is noise. The conflict
  // state is still recorded above, so reactivating the tab surfaces it via the
  // StatusBar "Conflict" entry for the user to act on.
  if (
    !shouldSurfaceConflictDialog(p.id, useTabsStore.getState().hidden, exists)
  ) {
    return;
  }
  const dlg = useConflictDialogStore.getState();
  // Don't re-open if this doc's dialog is already up (e.g. the user is
  // reviewing the compare view, or dismissed it with "Later"); the StatusBar
  // "Conflict" entry remains a manual re-entry point.
  if (dlg.openForId !== p.id) {
    dlg.open(p.id);
  }
}

export function useTypstCompile(): void {
  const [, startTransition] = useTransition();

  useTauriListener(onCompiled, (p) => {
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

  useTauriListener(onStatus, (p) => {
    useTabsStore
      .getState()
      .setStatus(p.id, p.revision, p.status, p.durationMs);
  });

  // Compile diagnostics: the backend emits the Typst diagnostic list on
  // every compile (empty on success → clears stale errors; populated on
  // failure → surfaces the error reason). §7 revision guard: drop events
  // whose revision is strictly older than the doc's current revision so a
  // slow compile of an older buffer can't clobber newer diagnostics.
  useTauriListener(onDiagnostics, (p) => {
    const doc = useDocumentsStore.getState().documents[p.id];
    if (!doc) return;
    if (p.revision < doc.revision) return;
    useDiagnosticsStore.getState().set(p.id, "compiler", p.diagnostics);
  });

  // §5.4 / §8.4: external-modification conflict. See handleConflictEvent.
  useTauriListener(onConflict, handleConflictEvent);

  // §5.3: mirror save-state transitions into the store for the status bar.
  // Same existence guard as onDiagnostics above: a hard-close races this
  // event, and writing state for a removed doc would orphan the byDoc entry
  // (nothing clears it afterwards — removeDocFromStores already ran).
  useTauriListener(onSaveStateChanged, (p) => {
    if (!(p.id in useDocumentsStore.getState().documents)) return;
    useSaveStateStore.getState().setSaveState(p.id, p.state);
  });

  // §6.4: a rename/move rebound open docs to new paths. Mirror the new path
  // into the documents store so tab titles / breadcrumbs / active-file
  // highlight track the rename. (The buffer, dirty, and revision are
  // unchanged — only the disk location moved.)
  useTauriListener(onDocsRebound, (p) => {
    for (const d of p.docs) {
      useDocumentsStore.getState().rebindDocPath(d.id, d.newPath);
    }
  });
}
