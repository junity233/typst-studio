import { useEffect, useTransition } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onCompiled, onDiagnostics, onStatus } from "../lib/tauri";
import { useDiagnosticsStore } from "../store/diagnosticsStore";
import { useTabsStore } from "../store/tabsStore";

/**
 * App-level subscription to the typst compile lifecycle. Mount once near the
 * root; it wires `compiled` / `diagnostics` / `status` events into the stores.
 *
 * Preview page updates (potentially large SVG payloads) are wrapped in
 * `startTransition` so React treats them as **low priority** — keystrokes and
 * other urgent updates flush first, and the preview re-render is deferred to
 * a gap in input activity.
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
        // processing is never blocked by preview reconciliation.
        startTransition(() => {
          tabs.setPages(p.id, p.pages);
        });
      });
      if (cancelled) {
        uCompiled();
        return;
      }
      unlistens.push(uCompiled);

      const uDiags = await onDiagnostics((p) => {
        // Only update the diagnostics store — status is driven by the separate
        // `status` event. This handler fires for both errors (non-empty list)
        // and success-clears (empty list), so it must not assume failure.
        useDiagnosticsStore.getState().set(p.id, p.diagnostics);
      });
      if (cancelled) {
        uDiags();
        return;
      }
      unlistens.push(uDiags);

      const uStatus = await onStatus((p) => {
        useTabsStore
          .getState()
          .setStatus(p.id, p.status, p.durationMs);
      });
      if (cancelled) {
        uStatus();
        return;
      }
      unlistens.push(uStatus);
    })();

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [startTransition]);
}
