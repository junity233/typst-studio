import { useEffect } from "react";
import { appLanguageClient } from "./appLanguageClient";
import { buildTinymistSettings } from "./tinymistSettings";
import { readSetting } from "../../hooks/useSetting";
import { useSettingsStore } from "../../store/settingsStore";

export { buildTinymistSettings };

/**
 * tinymist runtime configuration — the settings this app pushes to the
 * language server over `workspace/didChangeConfiguration` (section
 * `tinymist`, the same channel the VS Code extension uses).
 *
 * Delivery (verified against tinymist v0.15.2 over the app's WS relay): a
 * `workspace/didChangeConfiguration` notification with
 * `{ settings: { tinymist: { ... } } }` is logged by tinymist as
 * `config update_by_map` + "new settings applied", so formatter changes take
 * effect without restarting the server.
 *
 * Scope today: the formatter. tinymist 0.15 has NO spell-check option (the
 * only `spellcheck` string in its binary is a Typst HTML-element doc), so no
 * spelling settings are pushed.
 *
 * The pure settings builder lives in [`tinymistSettings.ts`](./tinymistSettings.ts)
 * (kept free of client imports so it's jsdom-testable); this module owns the
 * live push + React wiring.
 */

/**
 * Push the current `lsp.formatter*` settings to a RUNNING client. Returns
 * false (and sends nothing) when the client isn't running — the Ready
 * subscription in [`useTinymistConfigSync`] covers the start case.
 */
export function pushTinymistConfig(): boolean {
  const settings = buildTinymistSettings(
    readSetting<string>("lsp.formatterMode", "typstyle"),
    readSetting<number>("lsp.formatterPrintWidth", 0),
  );
  return appLanguageClient.sendDidChangeConfiguration(settings);
}

/**
 * Keep tinymist's config in sync with the app settings, mounted once from
 * `App`. Two triggers:
 *
 * 1. client → `Ready`: a fresh tinymist starts with server defaults; push the
 *    user's settings immediately (covers first connect + every reconnect).
 * 2. settings change (incl. cross-window, via the backend's
 *    `settings_changed` broadcast into the settings store): re-push while the
 *    client is running.
 */
export function useTinymistConfigSync(): void {
  // (1) after every Ready.
  useEffect(() => {
    return appLanguageClient.subscribe((snap) => {
      if (snap.state === "Ready") {
        pushTinymistConfig();
      }
    });
  }, []);

  // (2) on settings changes. Selecting the whole store data re-runs on every
  // settings edit; pushing an identical config is a no-op server-side, and
  // sendDidChangeConfiguration drops it entirely when not running.
  const settingsData = useSettingsStore((s) => s.data);
  useEffect(() => {
    pushTinymistConfig();
  }, [settingsData]);
}
