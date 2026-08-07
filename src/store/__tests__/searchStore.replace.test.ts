import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  searchWorkspace: vi.fn(),
  replaceInFiles: vi.fn(),
  applyExternalContent: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  searchWorkspace: mocks.searchWorkspace,
  replaceInFiles: mocks.replaceInFiles,
}));

vi.mock("../../hooks/useSetting", () => ({
  readSetting: (_path: string, fallback: number) => fallback,
}));

// The document store — a tiny in-memory stand-in so applyReplaceOutcome's
// setState is observable.
const docState = {
  documents: {} as Record<string, { content: string; revision: number; dirty: boolean }>,
};
vi.mock("../documentsStore", () => ({
  useDocumentsStore: {
    getState: () => docState,
    setState: (updater: (s: typeof docState) => typeof docState) => {
      const next = updater(docState);
      Object.assign(docState, next);
    },
  },
}));

// Dynamic import inside applyReplaceOutcome resolves to this mock.
vi.mock("../../components/Editor/monacoModelRegistry", () => ({
  monacoModelRegistry: {
    applyExternalContent: mocks.applyExternalContent,
  },
}));

import type { SearchHit } from "../../lib/types";
import { useSearchStore } from "../searchStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("searchStore replace", () => {
  beforeEach(() => {
    mocks.searchWorkspace.mockReset();
    mocks.replaceInFiles.mockReset();
    mocks.applyExternalContent.mockReset();
    mocks.applyExternalContent.mockReturnValue(true);
    docState.documents = {};
    useSearchStore.setState({
      query: "needle",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      results: [],
      searching: false,
      error: null,
      replaceValue: "pin",
      preserveCase: false,
      replacing: false,
    });
  });

  it("replaceAll builds a ReplaceRequest with target=null and re-runs search", async () => {
    mocks.replaceInFiles.mockResolvedValue({ closedFilesWritten: 1, openDocs: [], failed: [] });
    mocks.searchWorkspace.mockResolvedValue([]);

    await useSearchStore.getState().replaceAll();

    expect(mocks.replaceInFiles).toHaveBeenCalledTimes(1);
    const arg = mocks.replaceInFiles.mock.calls[0][0];
    expect(arg.target).toBeNull();
    expect(arg.replacement).toBe("pin");
    expect(arg.preserveCase).toBe(false);
    // Search re-ran so the result list refreshes.
    expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1);
    expect(useSearchStore.getState().replacing).toBe(false);
  });

  it("replaceAll applies a controlled replace to each open doc (Monaco + store)", async () => {
    mocks.replaceInFiles.mockResolvedValue({
      closedFilesWritten: 0,
      failed: [],
      openDocs: [
        { id: "doc-a", newContent: "pin", newRevision: 7, path: "/x/a.typ" },
        { id: "doc-b", newContent: "pin pin", newRevision: 3, path: "/x/b.typ" },
      ],
    });
    mocks.searchWorkspace.mockResolvedValue([]);
    // Seed the document store so setState has a doc to merge into.
    docState.documents = {
      "doc-a": { content: "needle", revision: 6, dirty: false },
      "doc-b": { content: "needle needle", revision: 2, dirty: true },
    };

    await useSearchStore.getState().replaceAll();

    // applyExternalContent called once per open doc, in order, carrying the
    // new revision.
    expect(mocks.applyExternalContent).toHaveBeenCalledTimes(2);
    expect(mocks.applyExternalContent.mock.calls[0]).toEqual(["doc-a", "pin", 7]);
    expect(mocks.applyExternalContent.mock.calls[1]).toEqual(["doc-b", "pin pin", 3]);
    // Document store merged: content + revision updated, dirty forced true.
    expect(docState.documents["doc-a"]).toEqual({ content: "pin", revision: 7, dirty: true });
    expect(docState.documents["doc-b"]).toEqual({ content: "pin pin", revision: 3, dirty: true });
  });

  it("replaceOne pins a target at the hit's line/column", async () => {
    mocks.replaceInFiles.mockResolvedValue({ closedFilesWritten: 0, openDocs: [], failed: [] });
    mocks.searchWorkspace.mockResolvedValue([]);
    const hit: SearchHit = {
      relative: "main.typ",
      line: 3,
      column: 1,
      lineText: "needle",
      matchStart: 0,
      matchEnd: 6,
    };

    await useSearchStore.getState().replaceOne(hit);

    expect(mocks.replaceInFiles).toHaveBeenCalledTimes(1);
    const arg = mocks.replaceInFiles.mock.calls[0][0];
    expect(arg.target).toEqual({ relative: "main.typ", line: 3, column: 1 });
  });

  it("preserveCase is forced false when isRegex (regex ignores it)", async () => {
    useSearchStore.setState({ isRegex: true, preserveCase: true });
    mocks.replaceInFiles.mockResolvedValue({ closedFilesWritten: 0, openDocs: [], failed: [] });
    mocks.searchWorkspace.mockResolvedValue([]);

    await useSearchStore.getState().replaceAll();

    const arg = mocks.replaceInFiles.mock.calls[0][0];
    expect(arg.preserveCase).toBe(false);
  });

  it("a newer run() supersedes the post-replace re-search", async () => {
    // The replace's trailing run() must be discardable if the user (or a newer
    // search) bumped runSeq while it was in flight.
    const staleSearch = deferred<SearchHit[]>();
    mocks.replaceInFiles.mockResolvedValue({ closedFilesWritten: 0, openDocs: [], failed: [] });
    mocks.searchWorkspace.mockReturnValueOnce(staleSearch.promise);

    const replaceP = useSearchStore.getState().replaceAll();
    // Invalidate (e.g. user typed) before the stale search resolves.
    useSearchStore.getState().invalidateResults();
    staleSearch.resolve([{ relative: "stale.typ", line: 1, column: 1, lineText: "x", matchStart: 0, matchEnd: 1 }]);
    await replaceP;

    // The stale post-replace search result was discarded.
    expect(useSearchStore.getState().results).toEqual([]);
  });

  it("capture and surface a replace error", async () => {
    mocks.replaceInFiles.mockRejectedValue(new Error("disk full"));

    await useSearchStore.getState().replaceAll();

    expect(useSearchStore.getState().error).toBe("disk full");
    expect(useSearchStore.getState().replacing).toBe(false);
  });
});
