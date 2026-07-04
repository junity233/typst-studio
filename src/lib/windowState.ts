/**
 * Window-state persistence (§7.2 "窗口大小、位置、最大化和全屏状态").
 *
 * Captured into the Session v2 `windowBounds` field on close and restored on
 * startup. The critical rule (§7.2): "窗口位置恢复必须裁剪到当前显示器可见区
 * 域" — a saved position from a now-removed external monitor must NOT reopen the
 * window off-screen. We clamp the restored (x,y) into the current monitor's
 * work area; if the saved position is fully off-screen we fall back to centered
 * on the current monitor.
 *
 * ## Approach: session, not the window-state plugin
 *
 * Tauri's `tauri-plugin-window-state` is opaque (persists via its own file,
 * outside Session v2). The spec wants window state IN the session (§7.2 lists
 * it under Session v2), so we restore/capture manually via the window API +
 * the session save/restore path. This keeps a single source of truth for
 * "where the user was" and lets the same clamping logic run on every restore.
 *
 * ## Purity / testing
 *
 * The monitor-clamp math ([`clampWindowToBounds`]) is pure and unit-tested
 * without the Tauri runtime. The capture/restore helpers are thin injectable
 * wrappers over the window API so the wiring is testable with stubs.
 */
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  currentMonitor,
} from "@tauri-apps/api/window";
import type { WindowBounds } from "./types";

/**
 * A monitor's geometry in logical pixels (the unit Tauri's position/size APIs
 * use on the current scale factor). `x`/`y` is the monitor's top-left relative
 * to the virtual screen origin; `width`/`height` is its size.
 */
export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimum visible margin (px). The restored window must keep at least this much
 * of itself inside the monitor so the user can grab the title bar / sash. A
 * window that leaves only this sliver visible is still "on screen" enough to
 * drag back; a window with less is treated as off-screen and recentered.
 */
const MIN_VISIBLE_PX = 96;

/**
 * Clamp a saved window position into `monitor`'s work area (§7.2).
 *
 * Returns the clamped `(x, y)`, or `null` if the saved position cannot be made
 * reasonably visible (the window is too large for the monitor, or the saved
 * position is entirely off-screen) — the caller then centers as a fallback.
 *
 * Rules:
 *  - If the saved (x,y) already places at least `MIN_VISIBLE_PX` of the window
 *    inside the monitor, return it unchanged.
 *  - Otherwise slide the window so its top-left is visible (clamped into
 *    `[monitor.x, monitor.x + monitor.width - MIN_VISIBLE_PX]`), preferring to
 *    keep the saved side (left vs right) when both fit.
 *  - If the window is wider/taller than the monitor (so even `MIN_VISIBLE_PX`
 *    can't fit alongside a visible top-left), return `null` → caller centers.
 *
 * Pure: no Tauri calls, trivially unit-testable.
 */
export function clampWindowToBounds(
  saved: { x: number; y: number; width: number; height: number },
  monitor: MonitorRect,
): { x: number; y: number } | null {
  const { x: sx, y: sy, width: w, height: h } = saved;
  const { x: mx, y: my, width: mw, height: mh } = monitor;

  // Window too large to keep a visible sliver on both axes → center fallback.
  if (mw < MIN_VISIBLE_PX || mh < MIN_VISIBLE_PX) return null;

  // The horizontal range of valid top-left x so that at least MIN_VISIBLE_PX of
  // the window is visible: [mx - (w - MIN_VISIBLE_PX), mx + mw - MIN_VISIBLE_PX].
  // (A window wider than the monitor can still show MIN_VISIBLE_PX with its
  // top-left as far left as mx-(w-MIN), i.e. its right edge sits at mx+MIN.)
  const xLo = mx - (w - MIN_VISIBLE_PX);
  const xHi = mx + mw - MIN_VISIBLE_PX;
  const yLo = my - (h - MIN_VISIBLE_PX);
  const yHi = my + mh - MIN_VISIBLE_PX;

  // If the valid range is empty on either axis, even MIN_VISIBLE_PX can't be
  // guaranteed → center fallback.
  if (xHi < xLo || yHi < yLo) return null;

  const x = Math.min(Math.max(sx, xLo), xHi);
  const y = Math.min(Math.max(sy, yLo), yHi);
  return { x, y };
}

/**
 * Compute a centered top-left for a window of `w`×`h` within `monitor`. Used as
 * the fallback when no position is saved or the saved position is off-screen.
 */
export function centerInMonitor(
  w: number,
  h: number,
  monitor: MonitorRect,
): { x: number; y: number } {
  return {
    x: Math.round(monitor.x + (monitor.width - w) / 2),
    y: Math.round(monitor.y + (monitor.height - h) / 2),
  };
}

/**
 * Capture the current window's geometry into a {@link WindowBounds} suitable for
 * a `save_session` patch (§7.2). Reads the live outer position + inner size +
 * maximized/fullscreen flags. Best-effort: any window-API failure resolves to
 * `null` (the caller skips the patch field, leaving the prior bounds).
 */
export async function captureWindowBounds(): Promise<WindowBounds | null> {
  try {
    const win = getCurrentWindow();
    const [pos, size, maximized, fullscreen] = await Promise.all([
      win.outerPosition(),
      win.innerSize(),
      win.isMaximized(),
      win.isFullscreen(),
    ]);
    // Tauri returns PhysicalPosition/PhysicalSize; convert to logical px via
    // the window's scale factor so the values round-trip at the same logical
    // size regardless of the monitor's DPI at restore time.
    const scaleFactor = await win.scaleFactor();
    const toLogical = (px: number) => Math.round(px / scaleFactor);
    return {
      width: toLogical(size.width),
      height: toLogical(size.height),
      x: toLogical(pos.x),
      y: toLogical(pos.y),
      maximized,
      fullscreen,
    };
  } catch (e) {
    console.warn("[windowState] captureWindowBounds failed:", e);
    return null;
  }
}

/**
 * Restore `bounds` onto the current window, clamped to the current monitor
 * (§7.2). Called once on startup, BEFORE the window is shown, so the user
 * never sees a flash at the default position.
 *
 * - If `bounds` is null/absent → no-op (the static config size/position stands).
 * - If maximized/fullscreen → apply size first, then the maximized/fullscreen
 *   flag (so an un-maximize restores to the right size).
 * - Clamp the (x,y) to the current monitor's work area; if off-screen (e.g. the
 *   saved external monitor was removed) center on the current monitor instead.
 *
 * Best-effort: any failure is logged and swallowed (startup must never block on
 * window geometry). Injectable `opts` for testing.
 */
export async function restoreWindowBounds(
  bounds: WindowBounds | null | undefined,
  opts?: {
    getCurrentWindow?: typeof getCurrentWindow;
    getCurrentMonitor?: typeof currentMonitor;
  },
): Promise<void> {
  if (!bounds) return;
  const win = opts?.getCurrentWindow?.() ?? getCurrentWindow();
  const getMonitor = opts?.getCurrentMonitor ?? currentMonitor;
  try {
    // `currentMonitor()` is a module-level function in Tauri v2 (not a Window
    // method). It returns the monitor the window is currently on, or null.
    const monitor = await getMonitor();
    // Size first (so a later un-maximize lands on the saved size).
    const width = Math.max(bounds.width, 100);
    const height = Math.max(bounds.height, 100);
    await win.setSize(new LogicalSize(width, height));

    // Position: clamp into the current monitor; center as the fallback.
    if (monitor) {
      const scaleFactor = monitor.scaleFactor;
      const monitorRect: MonitorRect = {
        x: monitor.position.x / scaleFactor,
        y: monitor.position.y / scaleFactor,
        width: monitor.size.width / scaleFactor,
        height: monitor.size.height / scaleFactor,
      };
      const savedPos =
        bounds.x != null && bounds.y != null
          ? clampWindowToBounds(
              { x: bounds.x, y: bounds.y, width, height },
              monitorRect,
            )
          : null;
      const pos = savedPos ?? centerInMonitor(width, height, monitorRect);
      await win.setPosition(new LogicalPosition(pos.x, pos.y));
    }

    // Apply chrome flags last so they take effect on the positioned/sized window.
    if (bounds.maximized) {
      try {
        await win.maximize();
      } catch (e) {
        console.warn("[windowState] maximize failed:", e);
      }
    }
    if (bounds.fullscreen) {
      try {
        await win.setFullscreen(true);
      } catch (e) {
        console.warn("[windowState] setFullscreen failed:", e);
      }
    }
  } catch (e) {
    console.warn("[windowState] restoreWindowBounds failed:", e);
  }
}
