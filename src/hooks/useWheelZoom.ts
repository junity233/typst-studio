import { useCallback } from "react";
import type { WheelEvent } from "react";

/**
 * Options for a wheel-zoom target.
 */
export interface WheelZoomOptions {
  /** Read the current zoom value (live — called on each wheel tick). */
  get: () => number | undefined;
  /** Persist the new value (typically the `useSetting` setter → set_setting IPC). */
  set: (value: number) => void;
  /** Inclusive lower bound (matches the manifest's `min`). */
  min: number;
  /** Inclusive upper bound (matches the manifest's `max`). */
  max: number;
  /** Step per wheel tick (e.g. 1 for fontSize, 0.1 for zoomLevel). */
  step: number;
  /**
   * Fallback when `get()` returns undefined (no persisted value yet). Should be
   * the manifest default so the first zoom tick starts from a sensible base.
   */
  fallback: number;
}

/**
 * Whether a wheel event should trigger zoom: only when Cmd (macOS) or Ctrl
 * (Win/Linux) is held. Plain wheel keeps normal scrolling / scroll-sync intact.
 *
 * PURE: no side effects, no I/O. Exported for unit testing.
 */
export function isZoomWheel(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/**
 * Compute the next zoom value from the current value + the wheel delta, clamped
 * to [min, max]. `deltaY < 0` (wheel up / away from user) zooms IN (increase),
 * `deltaY > 0` zooms OUT. Returns null when the clamped value equals the
 * current value (no change — caller can skip the persist call).
 *
 * PURE: no side effects, no I/O. Exported for unit testing.
 */
export function nextZoomStep(
  current: number,
  deltaY: number,
  opts: { min: number; max: number; step: number },
): number {
  const direction = deltaY < 0 ? 1 : -1;
  const raw = current + direction * opts.step;
  // Clamp + round to avoid float drift (e.g. 0.30000000000000004).
  const rounded = Math.round(raw * 1e6) / 1e6;
  return Math.min(opts.max, Math.max(opts.min, rounded));
}

/**
 * A React hook that returns a wheel handler for a pane container. Attach it to
 * a div's `onWheel`. When Cmd/Ctrl is held, the handler computes the next zoom
 * step from the current setting value and persists it (via the `set` callback,
 * typically the `useSetting` setter → `set_setting` IPC → backend broadcasts
 * `settings_changed` → all `useSetting` subscribers re-render → the consumer
 * applies the new value: Monaco via `editor.updateOptions({ fontSize })`, the
 * preview via `SvgPage`'s CSS `zoom`). Without the modifier, the handler does
 * nothing — normal scrolling and scroll-sync are preserved.
 *
 * The handler calls `preventDefault` + `stopPropagation` ONLY when it actually
 * zooms, so an unmodified wheel (or a zoom tick that's already at the bound)
 * still reaches the underlying scroll container.
 *
 * Usage:
 *   const [fontSize, setFontSize] = useSetting<number>("editor.fontSize");
 *   const onWheel = useWheelZoom({
 *     get: () => fontSize, set: setFontSize,
 *     min: 8, max: 32, step: 1, fallback: 13,
 *   });
 *   <div onWheel={onWheel}>...</div>
 *
 * NOTE on Monaco: Monaco's internal wheel listener can swallow the event
 * before React's bubble-phase `onWheel` fires. If Ctrl+wheel does nothing
 * inside the editor, attach a capture-phase native listener on the editor's
 * container instead (see `DirectMonacoEditor`'s wheel handling).
 */
export function useWheelZoom(
  opts: WheelZoomOptions,
): (e: WheelEvent) => void {
  // `opts` is captured at hook-call time. The `get` callback is expected to
  // read live state (e.g. via a ref or getState), so stale closures aren't a
  // concern. `set` is stable (useSetting's setter is useCallback'd on path).
  return useCallback(
    (e: WheelEvent) => {
      if (!isZoomWheel(e)) return;
      const current = opts.get() ?? opts.fallback;
      const next = nextZoomStep(current, e.deltaY, opts);
      if (next === current) return;
      e.preventDefault();
      e.stopPropagation();
      opts.set(next);
    },
    [opts],
  );
}
