/**
 * Platform detection helpers.
 *
 * Resolved once at module load from `navigator.userAgent` (stable across a
 * session). Used to gate platform-specific chrome — e.g. the custom Windows
 * titlebar (macOS/Linux keep their native window frames).
 *
 * Why userAgent and not a Tauri OS plugin call: this runs in the render path
 * of the app shell, where a synchronous boolean is needed. The Tauri `os`
 * plugin is async; userAgent is synchronous and sufficient for OS-family
 * branching. Webview userAgents are stable per-platform.
 */

/** True when running in a Windows webview. */
export const isWindows: boolean =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** True when running in a macOS / iOS webview. */
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
