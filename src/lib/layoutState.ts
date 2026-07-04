/**
 * UI-panel layout persistence (§7.2 "侧栏、诊断面板与预览可见性；分栏尺寸").
 *
 * The visibility flags (sidebar/preview/diagnostics) and pane widths are
 * captured into the Session v2 `layout` field on close and restored on startup.
 * The `window.*` settings (`window.sidebarVisible`/`window.previewVisible`)
 * remain as the FIRST-RUN fallback default; once a session has a `layout`, the
 * session wins (it reflects the user's most recent in-session choice, which the
 * settings never captured).
 *
 * ## What is (and isn't) persisted
 *
 * - sidebarVisible / previewVisible: from `useUiStore` (the View-menu toggles).
 * - diagnosticsVisible: the diagnostics panel's expanded state (the inverse of
 *   its local `collapsed` flag in `EditorArea`).
 * - sidebarWidth / previewWidth: the allotment/sash pane widths, when a custom
 *   size was captured. `null`/undefined ⇒ use the component default.
 *
 * Compile results and diagnostics CONTENT are NOT persisted (they regenerate).
 */
import type { LayoutState } from "./types";

/**
 * Capture the current UI layout into a {@link LayoutState} patch. Reads the
 * live visibility flags from the injected readers (so it stays pure/testable
 * and doesn't import the stores statically, avoiding cycles). Returns `null`
 * if no layout can be read (the caller skips the patch field).
 *
 * @param read visibility + pane-width readers (typically bound to the live
 *             stores in the production caller).
 */
export function captureLayout(read: {
  sidebarVisible: boolean;
  previewVisible: boolean;
  diagnosticsVisible: boolean;
  sidebarWidth?: number | null;
  previewWidth?: number | null;
}): LayoutState {
  return {
    sidebarVisible: read.sidebarVisible,
    previewVisible: read.previewVisible,
    diagnosticsVisible: read.diagnosticsVisible,
    sidebarWidth:
      typeof read.sidebarWidth === "number" ? read.sidebarWidth : null,
    previewWidth:
      typeof read.previewWidth === "number" ? read.previewWidth : null,
  };
}

/**
 * The effective layout to apply on startup. The session's `layout` wins when
 * present; otherwise the per-field settings fallbacks are used (so a fresh
 * install — or a v1 session with no layout — still gets the manifest defaults).
 *
 * @param sessionLayout  the session's `layout` (may be null for a v1 file).
 * @param settingsFallback  per-field fallbacks (typically the `window.*`
 *                          settings + component defaults).
 */
export function effectiveLayout(
  sessionLayout: LayoutState | null | undefined,
  settingsFallback: {
    sidebarVisible: boolean;
    previewVisible: boolean;
    diagnosticsVisible?: boolean;
  },
): LayoutState {
  const sl = sessionLayout ?? null;
  return {
    sidebarVisible: sl?.sidebarVisible ?? settingsFallback.sidebarVisible,
    previewVisible: sl?.previewVisible ?? settingsFallback.previewVisible,
    diagnosticsVisible:
      sl?.diagnosticsVisible ?? settingsFallback.diagnosticsVisible ?? false,
    sidebarWidth: sl?.sidebarWidth ?? null,
    previewWidth: sl?.previewWidth ?? null,
  };
}
