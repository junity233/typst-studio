import { describe, it, expect } from "vitest";
import type {
  WorkspaceEdit,
  TextEdit,
} from "vscode-languageserver-types";
import {
  planWorkspaceEdit,
  type PlannedDiskEdit,
} from "../workspaceEdit";

/**
 * Spec §12.2 (Tinymist workspace edit) — Task 10 Part B.
 *
 * `planWorkspaceEdit` is the PURE planning function that classifies a tinymist
 * `WorkspaceEdit` into model-targeted edits / disk-targeted operations /
 * confirmation requirements. The applier (the non-pure shell) consumes the
 * plan; THIS test pins the spec-critical classification + confirmation logic
 * with no I/O, no Monaco, no backend.
 *
 * The LSP `WorkspaceEdit` has two shapes:
 *
 *   - legacy `changes: { [uri]: TextEdit[] }` (text edits only, no resource ops)
 *   - modern `documentChanges: (TextDocumentEdit | CreateFile | RenameFile |
 *     DeleteFile)[]` (preferred when present — also the only form that can
 *     carry resource ops).
 *
 * Classification rules under test:
 *   - a text edit whose URI is OPEN        → applyToModel
 *   - a text edit whose URI is NOT open      → applyToDisk (text)
 *   - CreateFile / RenameFile / DeleteFile   → applyToDisk (matching op)
 *   - documentChanges present ⇒ changes ignored (LSP preference)
 *
 * Confirmation rules under test:
 *   - text edit (model or disk) onto a DIRTY/conflicted open doc → confirm
 *   - DeleteFile whose URI is dirty → confirm (delete-dirty)
 *   - RenameFile whose newUri is dirty → confirm (rename-overwrite)
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const OPEN_A = "file:///ws/a.typ";
const OPEN_B = "file:///ws/b.typ";
const DISK_C = "file:///ws/c.typ"; // not open
const DIRTY_A = OPEN_A; // open AND dirty

const openUris = new Set<string>([OPEN_A, OPEN_B]);
const dirtyUris = new Set<string>([DIRTY_A]);

/** Build a `TextEdit` (range + new text). */
function te(
  sl: number,
  sc: number,
  el: number,
  ec: number,
  newText: string,
): TextEdit {
  return {
    range: {
      start: { line: sl, character: sc },
      end: { line: el, character: ec },
    },
    newText,
  };
}

/** Build a `TextDocumentEdit` documentChanges entry. */
function tde(uri: string, edits: TextEdit[], version: number | null = null) {
  return {
    textDocument: { uri, version },
    edits,
  };
}

/** Find the planned disk edit for a URI (text form), or undefined. */
function findDiskText(plan: { applyToDisk: PlannedDiskEdit[] }, uri: string) {
  return plan.applyToDisk.find(
    (d): d is Extract<PlannedDiskEdit, { kind: "text" }> =>
      d.kind === "text" && d.uri === uri,
  );
}

// ---------------------------------------------------------------------------
// 1. Legacy `changes` form
// ---------------------------------------------------------------------------
describe("planWorkspaceEdit — legacy `changes` form", () => {
  it("routes an OPEN-URI text edit to applyToModel", () => {
    const edit: WorkspaceEdit = {
      changes: { [OPEN_B]: [te(0, 0, 0, 0, "hi")] },
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel).toHaveLength(1);
    expect(plan.applyToModel[0].uri).toBe(OPEN_B);
    expect(plan.applyToModel[0].edits).toEqual([te(0, 0, 0, 0, "hi")]);
    expect(plan.applyToDisk).toHaveLength(0);
    expect(plan.needsConfirmation).toHaveLength(0);
  });

  it("routes a NOT-OPEN-URI text edit to applyToDisk (text)", () => {
    const edit: WorkspaceEdit = {
      changes: { [DISK_C]: [te(0, 0, 0, 0, "hi")] },
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel).toHaveLength(0);
    expect(plan.applyToDisk).toHaveLength(1);
    const disk = findDiskText(plan, DISK_C);
    expect(disk).toBeDefined();
    expect(disk!.edits).toEqual([te(0, 0, 0, 0, "hi")]);
    expect(plan.needsConfirmation).toHaveLength(0);
  });

  it("mixes open + not-open URIs into the right buckets", () => {
    const edit: WorkspaceEdit = {
      changes: {
        [OPEN_B]: [te(1, 0, 1, 5, "x")],
        [DISK_C]: [te(2, 0, 2, 5, "y")],
      },
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel.map((e) => e.uri)).toEqual([OPEN_B]);
    expect(plan.applyToDisk.map((d) => (d.kind === "text" ? d.uri : ""))).toEqual([
      DISK_C,
    ]);
  });

  it("flags a confirmation for a text edit onto a DIRTY open doc", () => {
    // OPEN_A is open AND dirty.
    const edit: WorkspaceEdit = {
      changes: { [DIRTY_A]: [te(0, 0, 0, 1, "z")] },
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    // It's still routed to the model (the applier decides whether to apply
    // after confirmation); the confirmation is the GATE.
    expect(plan.applyToModel.map((e) => e.uri)).toEqual([DIRTY_A]);
    expect(plan.needsConfirmation).toContainEqual({
      uri: DIRTY_A,
      reason: "dirty-overwrite",
    });
  });

  it("an empty `changes` yields an empty plan", () => {
    const plan = planWorkspaceEdit({ changes: {} }, openUris, dirtyUris);
    expect(plan.applyToModel).toEqual([]);
    expect(plan.applyToDisk).toEqual([]);
    expect(plan.needsConfirmation).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Modern `documentChanges` form — TextDocumentEdit
// ---------------------------------------------------------------------------
describe("planWorkspaceEdit — documentChanges TextDocumentEdit", () => {
  it("routes an OPEN-URI TextDocumentEdit to applyToModel", () => {
    const edit: WorkspaceEdit = {
      documentChanges: [tde(OPEN_B, [te(0, 0, 0, 3, "new")])],
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel).toHaveLength(1);
    expect(plan.applyToModel[0].uri).toBe(OPEN_B);
    expect(plan.applyToDisk).toHaveLength(0);
  });

  it("routes a NOT-OPEN-URI TextDocumentEdit to applyToDisk (text)", () => {
    const edit: WorkspaceEdit = {
      documentChanges: [tde(DISK_C, [te(0, 0, 0, 3, "new")])],
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel).toHaveLength(0);
    expect(findDiskText(plan, DISK_C)).toBeDefined();
  });

  it("flags a confirmation for a TextDocumentEdit onto a DIRTY open doc", () => {
    const edit: WorkspaceEdit = {
      documentChanges: [tde(DIRTY_A, [te(0, 0, 0, 1, "z")])],
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel.map((e) => e.uri)).toEqual([DIRTY_A]);
    expect(plan.needsConfirmation).toContainEqual({
      uri: DIRTY_A,
      reason: "dirty-overwrite",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Modern `documentChanges` form — resource operations
// ---------------------------------------------------------------------------
describe("planWorkspaceEdit — documentChanges resource ops", () => {
  it("routes a CreateFile to applyToDisk (create)", () => {
    const op = {
      kind: "create" as const,
      uri: DISK_C,
      options: { overwrite: false, ignoreIfExists: true },
    };
    const edit: WorkspaceEdit = { documentChanges: [op] };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToDisk).toContainEqual({ kind: "create", op });
    expect(plan.applyToModel).toEqual([]);
  });

  it("routes a RenameFile to applyToDisk (rename)", () => {
    const op = {
      kind: "rename" as const,
      oldUri: DISK_C,
      newUri: "file:///ws/renamed.typ",
      options: { overwrite: false, ignoreIfExists: false },
    };
    const edit: WorkspaceEdit = { documentChanges: [op] };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToDisk).toContainEqual({ kind: "rename", op });
  });

  it("routes a DeleteFile to applyToDisk (delete)", () => {
    const op = {
      kind: "delete" as const,
      uri: DISK_C,
      options: { recursive: false, ignoreIfNotExists: true },
    };
    const edit: WorkspaceEdit = { documentChanges: [op] };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToDisk).toContainEqual({ kind: "delete", op });
  });

  it("flags confirmation for a DeleteFile on a DIRTY doc (delete-dirty)", () => {
    // OPEN_A is dirty — deleting its backing file loses unsaved edits.
    const op = { kind: "delete" as const, uri: DIRTY_A };
    const edit: WorkspaceEdit = { documentChanges: [op] };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.needsConfirmation).toContainEqual({
      uri: DIRTY_A,
      reason: "delete-dirty",
    });
    // Still routed to applyToDisk (the gate is the confirmation, not the bucket).
    expect(plan.applyToDisk).toContainEqual({ kind: "delete", op });
  });

  it("flags confirmation for a RenameFile WHOSE NEW URI is dirty (rename-overwrite)", () => {
    // Renaming some other file ONTO the dirty OPEN_A would clobber its unsaved
    // edits — confirm.
    const op = {
      kind: "rename" as const,
      oldUri: DISK_C,
      newUri: DIRTY_A,
    };
    const edit: WorkspaceEdit = { documentChanges: [op] };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.needsConfirmation).toContainEqual({
      uri: DIRTY_A,
      reason: "rename-overwrite",
    });
  });

  it("does NOT flag a DeleteFile whose URI is clean (no confirmation)", () => {
    const op = { kind: "delete" as const, uri: DISK_C };
    const edit: WorkspaceEdit = { documentChanges: [op] };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.needsConfirmation).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. documentChanges preference + mixed
// ---------------------------------------------------------------------------
describe("planWorkspaceEdit — documentChanges preferred over changes", () => {
  it("when BOTH are present, only documentChanges is planned (LSP preference)", () => {
    const edit: WorkspaceEdit = {
      changes: { [OPEN_B]: [te(0, 0, 0, 1, "ignored")] },
      documentChanges: [tde(OPEN_A, [te(0, 0, 0, 1, "kept")])],
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    // Only the documentChanges entry made it through.
    expect(plan.applyToModel.map((e) => e.uri)).toEqual([OPEN_A]);
    // The legacy changes entry for OPEN_B did NOT also produce a model edit
    // (would have been a duplicate-application bug).
    expect(plan.applyToModel).toHaveLength(1);
  });

  it("a mixed documentChanges batch classifies each entry independently", () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        tde(OPEN_B, [te(0, 0, 0, 1, "model")]), // open → model
        tde(DISK_C, [te(0, 0, 0, 1, "disk")]), // not open → disk text
        { kind: "create", uri: "file:///ws/new.typ" }, // resource op
        { kind: "delete", uri: DIRTY_A }, // dirty → confirm
      ],
    };
    const plan = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(plan.applyToModel.map((e) => e.uri)).toEqual([OPEN_B]);
    expect(findDiskText(plan, DISK_C)).toBeDefined();
    expect(plan.applyToDisk.some((d) => d.kind === "create")).toBe(true);
    expect(plan.needsConfirmation).toContainEqual({
      uri: DIRTY_A,
      reason: "delete-dirty",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------
describe("planWorkspaceEdit — edge cases", () => {
  it("an empty WorkspaceEdit ({}) yields an empty plan", () => {
    const plan = planWorkspaceEdit({}, openUris, dirtyUris);
    expect(plan.applyToModel).toEqual([]);
    expect(plan.applyToDisk).toEqual([]);
    expect(plan.needsConfirmation).toEqual([]);
  });

  it("is pure: calling twice with the same inputs yields equal plans", () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        tde(OPEN_B, [te(0, 0, 0, 1, "x")]),
        { kind: "create", uri: DISK_C },
      ],
    };
    const p1 = planWorkspaceEdit(edit, openUris, dirtyUris);
    const p2 = planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(p1).toEqual(p2);
  });

  it("does not mutate the input edit", () => {
    const edit: WorkspaceEdit = {
      changes: { [OPEN_B]: [te(0, 0, 0, 1, "x")] },
    };
    const snapshot = JSON.parse(JSON.stringify(edit));
    planWorkspaceEdit(edit, openUris, dirtyUris);
    expect(edit).toEqual(snapshot);
  });
});
