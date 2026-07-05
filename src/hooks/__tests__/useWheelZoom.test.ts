import { describe, it, expect } from "vitest";
import { isZoomWheel, nextZoomStep } from "../useWheelZoom";

describe("isZoomWheel — modifier detection", () => {
  it("returns true when metaKey is held", () => {
    expect(isZoomWheel({ metaKey: true, ctrlKey: false })).toBe(true);
  });

  it("returns true when ctrlKey is held", () => {
    expect(isZoomWheel({ metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("returns false when no modifier is held (plain scroll)", () => {
    expect(isZoomWheel({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("returns true when both modifiers are held", () => {
    expect(isZoomWheel({ metaKey: true, ctrlKey: true })).toBe(true);
  });
});

describe("nextZoomStep — zoom value computation", () => {
  const fontSizeOpts = { min: 8, max: 32, step: 1 };
  const zoomLevelOpts = { min: 0.25, max: 4, step: 0.1 };

  it("wheel up (deltaY < 0) increases the value (zoom in)", () => {
    expect(nextZoomStep(13, -100, fontSizeOpts)).toBe(14);
  });

  it("wheel down (deltaY > 0) decreases the value (zoom out)", () => {
    expect(nextZoomStep(13, 100, fontSizeOpts)).toBe(12);
  });

  it("clamps to max when zooming in past the upper bound", () => {
    expect(nextZoomStep(32, -100, fontSizeOpts)).toBe(32);
    expect(nextZoomStep(31, -100, fontSizeOpts)).toBe(32);
  });

  it("clamps to min when zooming out past the lower bound", () => {
    expect(nextZoomStep(8, 100, fontSizeOpts)).toBe(8);
    expect(nextZoomStep(9, 100, fontSizeOpts)).toBe(8);
  });

  it("works with fractional steps (preview zoomLevel)", () => {
    expect(nextZoomStep(1, -100, zoomLevelOpts)).toBe(1.1);
    expect(nextZoomStep(1.5, 100, zoomLevelOpts)).toBe(1.4);
  });

  it("rounds to avoid float drift", () => {
    // 0.1 increments would normally drift (0.30000000000000004); the
    // round-to-1e6 guard keeps it clean. Start from a value above `min` so the
    // clamp doesn't interfere.
    let v = 1.0;
    v = nextZoomStep(v, -100, zoomLevelOpts);
    v = nextZoomStep(v, -100, zoomLevelOpts);
    v = nextZoomStep(v, -100, zoomLevelOpts);
    expect(v).toBe(1.3);
  });

  it("clamps fractional values to the bounds", () => {
    expect(nextZoomStep(3.95, -100, zoomLevelOpts)).toBe(4);
    expect(nextZoomStep(0.3, 100, zoomLevelOpts)).toBe(0.25);
  });

  it("deltaY === 0 zooms out (direction = -1, the conservative choice)", () => {
    // A zero-delta wheel tick is ambiguous; treat it as zoom-out so a
    // trackpad's inertial "stop" tick doesn't accidentally zoom in.
    expect(nextZoomStep(13, 0, fontSizeOpts)).toBe(12);
  });
});
