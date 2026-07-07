/**
 * Opening external links (URLs) in the user's default browser.
 *
 * All link surfaces in the app — Monaco's Ctrl/Cmd+click-on-URL and the
 * react-markdown `<a>` renders (preview, assistant, package READMEs) — route
 * through {@link openExternalUrl} so the scheme allow-list and error handling
 * stay in one place.
 *
 * The browser is launched via `@tauri-apps/plugin-opener`'s `openUrl`, which
 * delegates to the OS and therefore bypasses the webview's CSP (which would
 * otherwise block external navigation). The `opener:default` capability on the
 * main window already permits the schemes listed in {@link isExternalHref}.
 */

import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Schemes that should be handed to the OS browser. Matches the URLs the
 * `opener:default` capability allows (`http`, `https`, `mailto`, `tel`).
 * Anything else (anchors, relative links, `javascript:`) is left to default
 * behavior.
 */
export function isExternalHref(href?: string): href is string {
  if (!href) return false;
  return /^(https?|mailto|tel):/i.test(href);
}

/**
 * Open `url` in the system default browser. No-ops (with a console warning) if
 * the opener rejects — e.g. when the scheme is outside the allowed scope or the
 * plugin isn't available — so a bad link never breaks the caller's flow.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (error) {
    console.warn("[openExternalUrl] failed to open:", url, error);
  }
}
