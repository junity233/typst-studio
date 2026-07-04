import { describe, it, expect } from "vitest";
import { computeModelSyncPlan } from "../editorModelSync";
import type { Document } from "../../../store/documentsStore";
import type { DocumentOrigin } from "../../../lib/types";

/**
 * Spec §8.3 / §10.1 / §10.4 / §10.5 — the pure planning seam behind
 * `MonacoEditor.tsx`'s model lifecycle. The component cannot be integration-
 * tested under vitest+jsdom (Monaco workers + widget CSS), so the open/close/
 * activate decisions are extracted into a pure helper that's trivially testable:
 * given the set of docs the editor has already seen and the live documents map,
 * decide what to [`openModel`](../monacoModelRegistry.ts), what to
 * [`closeModel`](../monacoModelRegistry.ts), and which id to
 * [`activate`](../monacoModelRegistry.ts) on the live editor.
 *
 * The helper owns NO registry/editor side effects — it only computes a plan.
 * `MonacoEditor.tsx` dispatches the plan against `monacoModelRegistry`.
 */

function makeDoc(
  id: string,
  overrides: Partial<Document> = {},
): Document {
  return {
    id,
    title: id,
    path: null,
    dirty: false,
    content: `#content ${id}`,
    origin: { kind: "untitled" } as DocumentOrigin,
    revision: 0,
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    ...overrides,
  };
}

describe("computeModelSyncPlan", () => {
  it("opens a brand-new document absent from prevSeenIds", () => {
    const a = makeDoc("a");
    const plan = computeModelSyncPlan(new Set(), { a }, null, null);

    expect(plan.toOpen).toEqual([
      {
        id: "a",
        content: a.content,
        origin: a.origin,
        revision: 0,
      },
    ]);
    expect(plan.toClose).toEqual([]);
    expect(plan.toActivate).toBeNull();
  });

  it("closes an id present in prevSeenIds but gone from currentDocs", () => {
    const plan = computeModelSyncPlan(new Set(["gone"]), {}, null, null);

    expect(plan.toOpen).toEqual([]);
    expect(plan.toClose).toEqual(["gone"]);
    expect(plan.toActivate).toBeNull();
  });

  it("activates when activeId differs from prevActiveId and is open", () => {
    const a = makeDoc("a");
    const plan = computeModelSyncPlan(
      new Set(["a"]),
      { a },
      "a" /* activeId */,
      null /* prevActiveId */,
    );

    expect(plan.toOpen).toEqual([]);
    expect(plan.toClose).toEqual([]);
    expect(plan.toActivate).toBe("a");
  });

  it("does NOT activate when activeId equals prevActiveId (no tab switch)", () => {
    const a = makeDoc("a");
    const plan = computeModelSyncPlan(new Set(["a"]), { a }, "a", "a");

    expect(plan.toActivate).toBeNull();
  });

  it("does NOT activate when activeId is null", () => {
    const plan = computeModelSyncPlan(new Set(), {}, null, "a");

    expect(plan.toActivate).toBeNull();
  });

  it("does NOT activate when activeId is not in currentDocs (defensive)", () => {
    // A brand-new active id that hasn't been opened yet this tick must not be
    // activated — the open happens first, activation on a later render. Guards
    // against activate() throwing on an unknown id.
    const plan = computeModelSyncPlan(
      new Set(["a"]),
      { a: makeDoc("a") },
      "b" /* activeId not in docs */,
      "a",
    );

    expect(plan.toActivate).toBeNull();
  });

  it("handles multiple opens and closes in one pass", () => {
    const b = makeDoc("b");
    const c = makeDoc("c", { revision: 7 });
    // prevSeen had {a, x}; now {b, c} — a and x closed, b and c opened.
    const plan = computeModelSyncPlan(new Set(["a", "x"]), { b, c }, null, null);

    expect(plan.toOpen).toHaveLength(2);
    expect(plan.toOpen.map((o) => o.id).sort()).toEqual(["b", "c"]);
    // revision carried through.
    const cOpen = plan.toOpen.find((o) => o.id === "c");
    expect(cOpen?.revision).toBe(7);
    expect(plan.toClose.sort()).toEqual(["a", "x"]);
  });

  it("returns an all-empty plan for a stable set with no activation change", () => {
    const a = makeDoc("a");
    const plan = computeModelSyncPlan(new Set(["a"]), { a }, "a", "a");

    expect(plan.toOpen).toEqual([]);
    expect(plan.toClose).toEqual([]);
    expect(plan.toActivate).toBeNull();
  });

  it("opens a newly-active doc AND activates it in the same plan", () => {
    // The common startup case: first render, prevSeenIds empty, activeId set,
    // active doc present in docs. The doc must be opened (toOpen) AND activated
    // (toActivate) — the component opens first, then activates the now-known id.
    const a = makeDoc("a");
    const plan = computeModelSyncPlan(new Set(), { a }, "a", null);

    expect(plan.toOpen).toEqual([
      { id: "a", content: a.content, origin: a.origin, revision: 0 },
    ]);
    expect(plan.toActivate).toBe("a");
  });

  it("opens AND activates when switching to a brand-new tab mid-session", () => {
    // The live tab-switch-to-new-doc path: prevActiveId non-null, activeId is a
    // doc present in currentDocs but NOT in prevSeenIds (just-added tab). The
    // doc must be both opened (toOpen) and activated (toActivate).
    const a = makeDoc("a");
    const b = makeDoc("b");
    const plan = computeModelSyncPlan(new Set(["a"]), { a, b }, "b", "a");

    expect(plan.toOpen.map((o) => o.id)).toEqual(["b"]);
    expect(plan.toClose).toEqual([]);
    expect(plan.toActivate).toBe("b");
  });

  it("treats an already-seen id as NOT to-open (idempotent open)", () => {
    // A doc that survives a render must not be re-opened — openModel would be
    // a redundant create. This is the guard the component relies on to open
    // each id exactly once across its open lifetime.
    const a = makeDoc("a");
    const plan = computeModelSyncPlan(new Set(["a"]), { a }, null, null);

    expect(plan.toOpen).toEqual([]);
  });
});
