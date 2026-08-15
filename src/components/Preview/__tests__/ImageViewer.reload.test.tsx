import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../../test/react";

// Viewer path under test (single-backslash Windows form). A TS constant is used
// because JSX ATTRIBUTE string literals do not process backslash escapes —
// writing `path="D:\\ws\\…"` would pass a literal double-backslash string.
const VIEWER_PATH = "D:\\ws\\img\\Chart.png";

// Captured `onFsChanged` handlers let tests emit `fs_changed` payloads exactly
// like the backend watcher would.
const mocks = vi.hoisted(() => ({
  handlers: [] as Array<(payload: { paths: string[] }) => void>,
  readFileBytesCached: vi.fn(),
}));

vi.mock("../../../lib/tauri", () => ({
  onFsChanged: (handler: (payload: { paths: string[] }) => void) => {
    mocks.handlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

// Keep the REAL fsChangeAffectsPath (that is the unit under wiring test);
// only stub the byte fetch so reloads are observable as extra calls.
vi.mock("../../../lib/viewerByteCache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/viewerByteCache")>();
  return { ...actual, readFileBytesCached: mocks.readFileBytesCached };
});

vi.mock("../../../i18n", () => ({
  default: { t: (key: string) => key },
}));

import { ImageViewer } from "../ImageViewer";

// jsdom does not implement blob object URLs; stub them (with a counter so a
// reload is also visible as a fresh <img src>).
let blobSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${(blobSeq += 1)}`);
const revokeObjectURL = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterAll(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

const h = reactHarness();

beforeEach(async () => {
  mocks.handlers.length = 0;
  mocks.readFileBytesCached.mockReset();
  mocks.readFileBytesCached.mockImplementation(
    () => Promise.resolve(new Uint8Array([1, 2, 3])),
  );
  await h.renderAsync(<ImageViewer path={VIEWER_PATH} />);
});

afterEach(() => {
  h.cleanup();
});

/** Emit a `fs_changed` payload to every registered listener. */
async function emitFsChanged(paths: string[]): Promise<void> {
  await act(async () => {
    for (const handler of [...mocks.handlers]) handler({ paths });
  });
}

describe("ImageViewer reloads on fs_changed", () => {
  it("loads once on mount and renders the image", () => {
    expect(mocks.readFileBytesCached).toHaveBeenCalledTimes(1);
    expect(mocks.readFileBytesCached).toHaveBeenCalledWith(VIEWER_PATH);
    expect(h.container.querySelector("img")).not.toBeNull();
  });

  it("reloads when the payload contains an equivalent path (case/separator-insensitive)", async () => {
    const before = h.container.querySelector("img")?.getAttribute("src");
    await emitFsChanged(["D:/unrelated.txt", "d:/ws/IMG/chart.PNG"]);

    expect(mocks.readFileBytesCached).toHaveBeenCalledTimes(2);
    const after = h.container.querySelector("img")?.getAttribute("src");
    expect(after).not.toBe(before);
  });

  it("does not reload when the payload only contains unrelated paths", async () => {
    await emitFsChanged(["D:\\ws\\other.pdf"]);

    expect(mocks.readFileBytesCached).toHaveBeenCalledTimes(1);
  });

  it("reloads on the empty-payload generic refresh", async () => {
    await emitFsChanged([]);

    expect(mocks.readFileBytesCached).toHaveBeenCalledTimes(2);
  });
});
