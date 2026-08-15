import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../test/react";
import { useFsReloadKey } from "../useFsReloadKey";

/**
 * Pins the binary-viewer reload contract both ImageViewer and PdfViewer rely
 * on: a `fs_changed` for the watched path (or a generic refresh — empty
 * `paths`) bumps the key so the load effect re-runs; a change to some OTHER
 * file must NOT reload the viewer.
 */

// Fake `onFsChanged`: registration resolves immediately; the captured handler
// lets the test deliver payloads exactly like the backend would.
let emit: ((paths: string[]) => void) | null = null;
vi.mock("../../lib/tauri", () => ({
  onFsChanged: (handler: (payload: { paths: string[] }) => void) => {
    emit = (paths: string[]) => handler({ paths });
    return Promise.resolve(() => {});
  },
}));

function Probe({ path, onKey }: { path: string; onKey: (key: number) => void }) {
  onKey(useFsReloadKey(path));
  return null;
}

const h = reactHarness();

function mountProbe(onKey: (key: number) => void): void {
  h.render(<Probe path="/w/a.png" onKey={onKey} />);
}

describe("useFsReloadKey", () => {
  beforeEach(() => {
    emit = null;
  });

  it("starts at 0 and bumps on a change to the watched path", () => {
    const keys: number[] = [];
    mountProbe((k) => keys.push(k));
    expect(keys[0]).toBe(0);
    act(() => emit?.(["/w/a.png"]));
    expect(keys[keys.length - 1]).toBe(1);
    h.unmount();
  });

  it("bumps on a generic refresh (empty paths)", () => {
    const keys: number[] = [];
    mountProbe((k) => keys.push(k));
    act(() => emit?.([]));
    expect(keys[keys.length - 1]).toBe(1);
    h.unmount();
  });

  it("does NOT bump for an unrelated path", () => {
    const keys: number[] = [];
    mountProbe((k) => keys.push(k));
    act(() => emit?.(["/w/other/b.typ"]));
    expect(keys).toEqual([0]);
    h.unmount();
  });
});
