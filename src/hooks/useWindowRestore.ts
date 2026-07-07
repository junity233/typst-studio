import { useEffect } from "react";
import { loadSession } from "../lib/session";
import { restoreWindowBounds } from "../lib/windowState";

/**
 * One-shot guard so the restore runs exactly once even under React 18
 * StrictMode's mount→unmount→remount in dev.
 */
let windowRestored = false;

/**
 * Restore the persisted window geometry + layout on startup (§7.2 "窗口大小、
 * 位置、最大化和全屏状态" + "侧栏、诊断面板与预览可见性；分栏尺寸"). Reads
 * `windowBounds` and `layout` from the session and applies them:
 *   - window bounds → the current window, clamped to the monitor's work area
 *     (§7.2 "窗口位置恢复必须裁剪到当前显示器可见区域");
 *   - layout.previewWidth → localStorage (`ts-preview-width`), so EditorArea's
 *     own startup read picks it up. (The sidebar/preview/diagnostics visibility
 *     flags are restored in Workbench/EditorArea directly from session.layout.)
 *
 * Run once near the app root. Idempotent: a second invocation (e.g. StrictMode
 * remount) is a no-op. Best-effort: any failure is logged and swallowed inside
 * [`restoreWindowBounds`] — startup must never block on window geometry. The
 * window may briefly render at the static config size before snapping to the
 * restored bounds; a true "restore before show" would require `visible:false`
 * in the config + a `show()` after restore, deferred as a future polish.
 */
export function useWindowRestore(): void {
  useEffect(() => {
    if (windowRestored) return;
    windowRestored = true;
    void (async () => {
      try {
        const session = await loadSession();
        // Seed the preview-pane width from the session layout (if present) into
        // localStorage, so EditorArea's own startup read picks it up. This keeps
        // the session as the single source of truth while reusing the existing
        // localStorage-backed width management.
        const pw = session.layout?.previewWidth;
        if (typeof pw === "number" && pw >= 240) {
          try {
            localStorage.setItem("ts-preview-width", String(pw));
          } catch {
            // ignore quota / privacy-mode failures
          }
        }
        // Seed the sidebar-pane width the same way, for Workbench's startup
        // read of `ts-sidebar-width`.
        const sw = session.layout?.sidebarWidth;
        if (typeof sw === "number" && sw >= 0) {
          try {
            localStorage.setItem("ts-sidebar-width", String(sw));
          } catch {
            // ignore quota / privacy-mode failures
          }
        }
        await restoreWindowBounds(session.windowBounds ?? null);
      } catch (e) {
        console.warn("[windowState] startup restore failed:", e);
      }
    })();
  }, []);
}
