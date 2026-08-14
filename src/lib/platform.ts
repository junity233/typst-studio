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

/**
 * True when running inside the Tauri native shell. Tauri injects
 * `window.__TAURI_INTERNALS__` (the IPC transport) into its webview; a plain
 * browser (or the IAB used for dev/visual checks) lacks it, and any Tauri API
 * call there throws synchronously. Gate shell-only chrome on this so the
 * frontend can render outside Tauri.
 */
export const isTauri: boolean =
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in window;

/** True when running in a Windows webview. */
export const isWindows: boolean =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** True when running in a macOS / iOS webview. */
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
