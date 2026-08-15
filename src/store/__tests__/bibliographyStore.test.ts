import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Out-of-order async parse guard (mirrors the discoverGen race in
 * `discoverFiles`): a slow `loadFile(A)` completing after the user switched to
 * file B must not attach A's entries while B is active.
 */

const mocks = vi.hoisted(() => ({
  bibliographyDiscover: vi.fn(),
  bibliographyParse: vi.fn(),
  bibliographyParseFull: vi.fn(),
  bibliographySaveEntries: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  bibliographyDiscover: mocks.bibliographyDiscover,
  bibliographyParse: mocks.bibliographyParse,
  bibliographyParseFull: mocks.bibliographyParseFull,
  bibliographySaveEntries: mocks.bibliographySaveEntries,
}));

import type { BibEntry, BibEntryEditable } from "../../lib/types";
import { useBibliographyStore } from "../bibliographyStore";

const entry: BibEntry = {
  key: "knuth1984",
  entryType: "article",
  title: "Literate Programming",
  authors: ["Donald Knuth"],
  year: 1984,
};
const fullEntry: BibEntryEditable = {
  key: "knuth1984",
  entryType: "article",
  title: "Literate Programming",
  authors: ["Donald Knuth"],
  year: 1984,
  extra: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("bibliographyStore.loadFile ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBibliographyStore.setState({
      discoveredFiles: [],
      activeFilePath: null,
      entries: [],
      fullEntries: [],
      query: "",
      loading: false,
      error: null,
      failedPaths: [],
    });
  });

  it("drops a stale parse that completes after a newer file was loaded", async () => {
    const slowA = deferred<BibEntry[]>();
    const slowAFull = deferred<BibEntryEditable[]>();
    mocks.bibliographyParse.mockImplementation((path: string) =>
      path === "/ws/a.bib"
        ? slowA.promise
        : Promise.resolve([{ ...entry, key: "b" }]),
    );
    mocks.bibliographyParseFull.mockImplementation((path: string) =>
      path === "/ws/a.bib"
        ? slowAFull.promise
        : Promise.resolve([{ ...fullEntry, key: "b" }]),
    );

    const loadA = useBibliographyStore.getState().loadFile("/ws/a.bib");
    const loadB = useBibliographyStore.getState().loadFile("/ws/b.bib");
    await loadB;
    // A's slow parse finishes AFTER B became active — must be discarded.
    slowA.resolve([entry]);
    slowAFull.resolve([fullEntry]);
    await loadA;

    const s = useBibliographyStore.getState();
    expect(s.activeFilePath).toBe("/ws/b.bib");
    expect(s.entries.map((e) => e.key)).toEqual(["b"]);
    expect(s.fullEntries.map((e) => e.key)).toEqual(["b"]);
    expect(s.loading).toBe(false);
  });

  it("drops a stale parse that completes after a discovery reset", async () => {
    const slowParse = deferred<BibEntry[]>();
    const slowFull = deferred<BibEntryEditable[]>();
    mocks.bibliographyParse.mockReturnValue(slowParse.promise);
    mocks.bibliographyParseFull.mockReturnValue(slowFull.promise);
    mocks.bibliographyDiscover.mockResolvedValue([]);

    const load = useBibliographyStore.getState().loadFile("/ws/old.bib");
    await useBibliographyStore.getState().discoverFiles("/ws2");
    slowParse.resolve([entry]);
    slowFull.resolve([fullEntry]);
    await load;

    const s = useBibliographyStore.getState();
    expect(s.activeFilePath).toBeNull();
    expect(s.entries).toEqual([]);
    expect(s.fullEntries).toEqual([]);
    expect(s.loading).toBe(false);
  });
});

describe("bibliographyStore.saveEntries ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBibliographyStore.setState({
      discoveredFiles: [],
      activeFilePath: null,
      entries: [],
      fullEntries: [],
      query: "",
      loading: false,
      error: null,
      failedPaths: [],
    });
  });

  it("drops the post-save re-parse when a newer file was loaded mid-save", async () => {
    // saveEntries awaits the write + a re-parse of the SAME file; if the user
    // switched files in between (loadFile bumps the generation), the stale
    // re-parse must not overwrite the new file's entries.
    const slowReParse = deferred<BibEntry[]>();
    const slowReParseFull = deferred<BibEntryEditable[]>();
    mocks.bibliographySaveEntries.mockResolvedValue(undefined);
    mocks.bibliographyParse.mockImplementation((path: string) =>
      path === "/ws/a.bib" ? slowReParse.promise : Promise.resolve([{ ...entry, key: "b" }]),
    );
    mocks.bibliographyParseFull.mockImplementation((path: string) =>
      path === "/ws/a.bib" ? slowReParseFull.promise : Promise.resolve([{ ...fullEntry, key: "b" }]),
    );

    useBibliographyStore.setState({ activeFilePath: "/ws/a.bib" });
    const save = useBibliographyStore.getState().saveEntries([fullEntry]);
    // The user switches to file B while A's save + re-parse is in flight.
    await useBibliographyStore.getState().loadFile("/ws/b.bib");
    // A's re-parse finishes AFTER B became active — must be discarded.
    slowReParse.resolve([entry]);
    slowReParseFull.resolve([fullEntry]);
    await save;

    const s = useBibliographyStore.getState();
    expect(s.activeFilePath).toBe("/ws/b.bib");
    expect(s.entries.map((e) => e.key)).toEqual(["b"]);
    expect(s.fullEntries.map((e) => e.key)).toEqual(["b"]);
    expect(s.loading).toBe(false);
  });

  it("drops the error set() when a newer file was loaded before the save failed", async () => {
    mocks.bibliographySaveEntries.mockRejectedValue(new Error("disk full"));
    mocks.bibliographyParse.mockResolvedValue([{ ...entry, key: "b" }]);
    mocks.bibliographyParseFull.mockResolvedValue([{ ...fullEntry, key: "b" }]);

    useBibliographyStore.setState({ activeFilePath: "/ws/a.bib" });
    const save = useBibliographyStore.getState().saveEntries([fullEntry]);
    await useBibliographyStore.getState().loadFile("/ws/b.bib");
    await save;

    const s = useBibliographyStore.getState();
    // B stays loaded and error-free — the stale failure belongs to A.
    expect(s.activeFilePath).toBe("/ws/b.bib");
    expect(s.error).toBeNull();
    expect(s.loading).toBe(false);
  });
});
