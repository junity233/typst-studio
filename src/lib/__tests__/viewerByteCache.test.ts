import { beforeEach, describe, expect, it, vi } from "vitest";

// The module under test imports `readFileBytes` from ../tauri; mock just that
// one export so no Tauri IPC is attempted. Each call returns a fresh, uniquely
// numbered buffer so stale cached bytes are distinguishable from fresh reads.
vi.mock("../tauri", () => ({
  readFileBytes: vi.fn(),
}));

import { readFileBytes } from "../tauri";
import {
  readFileBytesCached,
  invalidateViewerByteCache,
  invalidateFsChanged,
  fsChangeAffectsPath,
} from "../viewerByteCache";

/**
 * Reads `path` and returns its first byte — the generation counter baked into
 * every mock fetch — so tests can assert on content freshness, not just call
 * counts.
 */
async function firstByte(path: string): Promise<number> {
  const bytes = await readFileBytesCached(path);
  return bytes[0] ?? -1;
}

describe("viewerByteCache", () => {
  beforeEach(() => {
    // The cache is module-level state; reset it (and the mock) between tests.
    invalidateViewerByteCache();
    vi.mocked(readFileBytes).mockReset();
    let generation = 0;
    vi.mocked(readFileBytes).mockImplementation(
      (path) =>
        new Promise<Uint8Array>((resolve) => {
          void path;
          generation += 1;
          resolve(new Uint8Array([generation]));
        }),
    );
  });

  it("serves a repeated read of the same path from the cache", async () => {
    const a = await firstByte("D:\\ws\\a.png");
    const b = await firstByte("D:\\ws\\a.png");

    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("evicts the least-recently-used entry past the 8-entry bound", async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `D:\\ws\\f${i}.png`);
    for (const p of paths) await firstByte(p);

    // 9 distinct reads = 9 fetches; the oldest (f0) was evicted...
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(9);
    await firstByte(paths[0]);
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(10);
    // ...while the newest (f8) is still cached.
    await firstByte(paths[8]);
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(10);
  });

  it("moves an entry to the back on a hit, so it survives a later overflow", async () => {
    // Fill the cache exactly (8 entries, f0 oldest).
    const paths = Array.from({ length: 8 }, (_, i) => `D:\\ws\\f${i}.png`);
    for (const p of paths) await firstByte(p);
    // Refresh f0: it becomes most-recently-used, f1 is now the LRU victim.
    await firstByte(paths[0]);
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(8);
    // Overflow by one — evicts f1, not f0.
    await firstByte("D:\\ws\\overflow.png");

    await firstByte(paths[0]);
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(9);
    await firstByte(paths[1]);
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(10);
  });

  it("invalidateViewerByteCache(path) drops one entry and forces a refetch", async () => {
    const stale = await firstByte("D:\\ws\\a.png");
    invalidateViewerByteCache("D:\\ws\\a.png");
    const fresh = await firstByte("D:\\ws\\a.png");

    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(2);
    expect(fresh).not.toBe(stale);
  });

  it("invalidateViewerByteCache() clears the whole cache", async () => {
    await firstByte("D:\\ws\\a.png");
    await firstByte("D:\\ws\\b.png");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(2);

    invalidateViewerByteCache();
    await firstByte("D:\\ws\\a.png");
    await firstByte("D:\\ws\\b.png");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(4);
  });

  it("invalidateFsChanged matches Windows-equivalent separators and case", async () => {
    await firstByte("D:\\ws\\img\\Chart.png");
    await firstByte("D:\\ws\\other.pdf");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(2);

    // Same file as the cached key, but forward slashes and different case —
    // an exact `cache.delete(path)` would miss this.
    invalidateFsChanged(["D:/WS/IMG/chart.PNG"]);

    await firstByte("D:\\ws\\img\\Chart.png");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(3);
    // The untouched entry survives.
    await firstByte("D:\\ws\\other.pdf");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(3);
  });

  it("invalidateFsChanged leaves entries whose paths did not change", async () => {
    await firstByte("D:\\ws\\a.png");
    await firstByte("D:\\ws\\b.png");

    invalidateFsChanged(["D:\\ws\\c.png"]);

    await firstByte("D:\\ws\\a.png");
    await firstByte("D:\\ws\\b.png");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(2);
  });

  it("invalidateFsChanged([]) is a generic refresh and clears everything", async () => {
    await firstByte("D:\\ws\\a.png");
    await firstByte("D:\\ws\\b.png");

    invalidateFsChanged([]);

    await firstByte("D:\\ws\\a.png");
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledTimes(3);
  });

  it("fsChangeAffectsPath matches exact and equivalent paths only", () => {
    const viewerPath = "D:\\ws\\img\\Chart.png";
    expect(fsChangeAffectsPath(viewerPath, [viewerPath])).toBe(true);
    expect(
      fsChangeAffectsPath(viewerPath, ["D:/ws/IMG/chart.png", "D:\\other"]),
    ).toBe(true);
    expect(fsChangeAffectsPath(viewerPath, ["D:\\ws\\other.pdf"])).toBe(false);
    expect(fsChangeAffectsPath(viewerPath, [])).toBe(false);
  });
});
