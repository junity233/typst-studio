import { useEffect, useTransition } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onCompiled, onStatus } from "../lib/tauri";
import { useTabsStore } from "../store/tabsStore";

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
          tabs.setPages(p.id, p.pages, p.lineMap);
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
