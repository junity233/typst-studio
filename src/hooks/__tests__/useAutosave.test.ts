import { describe, it, expect } from "vitest";
import { selectAutosavable } from "../useAutosave";

describe("selectAutosavable (§7.1 suspension rules)", () => {
  const doc = (over: Partial<{
    id: string;
    path: string | null;
    dirty: boolean;
    conflict: boolean;
    saveFailed: boolean;
  }>) => ({
    id: "d1",
    path: "/x.typ",
    dirty: true,
    conflict: false,
    saveFailed: false,
    ...over,
  });

  it("selects a dirty disk-backed non-conflicted doc", () => {
    expect(selectAutosavable([doc({ id: "a" })])).toEqual(["a"]);
  });

  it("skips untitled docs (no path) — §7.1", () => {
    expect(selectAutosavable([doc({ id: "a", path: null })])).toEqual([]);
  });

  it("skips clean docs (not dirty)", () => {
    expect(selectAutosavable([doc({ id: "a", dirty: false })])).toEqual([]);
  });

  it("skips conflicted docs — §5.4 gate / §7.1 suspend", () => {
    expect(selectAutosavable([doc({ id: "a", conflict: true })])).toEqual([]);
  });

  it("skips docs whose last save failed — §7.1 suspend", () => {
    expect(selectAutosavable([doc({ id: "a", saveFailed: true })])).toEqual([]);
  });

  it("selects multiple eligible docs and skips the rest", () => {
    const docs = [
      doc({ id: "ok1" }),
      doc({ id: "untitled", path: null }),
      doc({ id: "clean", dirty: false }),
      doc({ id: "conf", conflict: true }),
      doc({ id: "failed", saveFailed: true }),
      doc({ id: "ok2" }),
    ];
    expect(selectAutosavable(docs)).toEqual(["ok1", "ok2"]);
  });
});
