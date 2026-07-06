import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchWorkspace: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  searchWorkspace: mocks.searchWorkspace,
}));

vi.mock("../../hooks/useSetting", () => ({
  readSetting: (_path: string, fallback: number) => fallback,
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

describe("search workspace invalidation", () => {
  beforeEach(() => {
    mocks.searchWorkspace.mockReset();
    useSearchStore.setState({
      query: "needle",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      results: [],
      searching: false,
      error: null,
    });
  });

  it("discards an old-workspace result while retaining the query", async () => {
    const oldRequest = deferred<SearchHit[]>();
    mocks.searchWorkspace.mockReturnValueOnce(oldRequest.promise);

    const run = useSearchStore.getState().run();
    useSearchStore.getState().invalidateResults();
    oldRequest.resolve([
      {
        relative: "old.typ",
        line: 1,
        column: 1,
        lineText: "needle",
        matchStart: 0,
        matchEnd: 6,
      },
    ]);
    await run;

    expect(useSearchStore.getState().results).toEqual([]);
    expect(useSearchStore.getState().query).toBe("needle");
    expect(useSearchStore.getState().searching).toBe(false);
  });
});
