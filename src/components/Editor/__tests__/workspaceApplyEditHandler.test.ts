import { describe, it, expect, vi } from "vitest";
import type { TextEdit } from "vscode-languageserver-types";
import {
  applyModelEdits,
  confirmationMessage,
  executeWorkspaceEditPlan,
  applyDiskEdits,
  type DiskApplyFailure,
} from "../workspaceEditApplier";
import type { PlannedDiskEdit, PlannedModelEdit } from "../workspaceEdit";

/**
 * Spec §12.2 — Task 10 Part B (the non-pure application layer).
 *
 * The four dependency-injected seams in
 * [`workspaceEditApplier.ts`](../workspaceEditApplier.ts) are tested here with
 * fakes (no Monaco, no backend, no dialog store — that module is Monaco-free so
 * jsdom can run it). The seams:
 *
 *   - [`applyModelEdits`](Self.applyModelEdits): converts LSP TextEdit[] →
 *     Monaco edit ops and applies them to the resolved model. Tests pin the
 *     0-indexed→1-indexed conversion + the resolve-then-apply sequence + the
 *     failure collection.
 *   - [`confirmationMessage`](Self.confirmationMessage): pure presentational.
 *   - [`executeWorkspaceEditPlan`](Self.executeWorkspaceEditPlan): the orchestration
 *     (confirm → model → disk → result). Drives the deps in dependency-injection
 *     form so the gate ordering + result shapes are pinnable.
 *   - [`applyDiskEdits`](Self.applyDiskEdits): resource-op routing +
 *     un-open-file text-edit Phase D limitation.
 *
 * The production wiring (`handleApplyWorkspaceEdit`, the registration helper,
 * `collectOpenAndDirtyUris`) lives in `workspaceApplyEditHandler.ts` and pulls
 * in the real registry/store/dialog; it is exercised at integration time, not
 * here.
 */

// ---------------------------------------------------------------------------
// Fixtures: a fake registry + fake model
// ---------------------------------------------------------------------------
interface FakeModel {
  uri: string;
  pushEditOperations: ReturnType<typeof vi.fn>;
  /** Post-"edit" text read back by applyModelEdits for the inactive sync. */
  getValue: ReturnType<typeof vi.fn>;
}
interface FakeRegistry {
  resolveDocumentId: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  __models: Map<string, FakeModel>; // by documentId
}

function fakeRegistry(open: Record<string, { uri: string; id: string; value?: string }>): {
  registry: FakeRegistry;
  models: Map<string, FakeModel>;
} {
  const models = new Map<string, FakeModel>();
  const uriToId = new Map<string, string>();
  for (const { uri, id, value } of Object.values(open)) {
    uriToId.set(uri, id);
    const m: FakeModel = {
      uri,
      pushEditOperations: vi.fn(),
      getValue: vi.fn(() => value ?? ""),
    };
    models.set(id, m);
  }
  const registry: FakeRegistry = {
    resolveDocumentId: vi.fn((uri: string) => uriToId.get(uri) ?? null),
    getModel: vi.fn((id: string) => {
      const m = models.get(id);
      return m === undefined
        ? undefined
        : { model: m, uri: m.uri };
    }),
    __models: models,
  };
  return { registry, models };
}

/** A no-op inactive-model sync recorder (default third dep in most tests). */
function fakeSync(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

/** Build an LSP TextEdit. */
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

// ---------------------------------------------------------------------------
// 1. applyModelEdits
// ---------------------------------------------------------------------------
describe("applyModelEdits", () => {
  it("converts LSP 0-indexed ranges to Monaco 1-indexed ops and applies them", () => {
    const { registry, models } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a" },
    });
    const edits: PlannedModelEdit[] = [
      { uri: "file:///a.typ", edits: [te(0, 0, 0, 3, "hi")] },
    ];

    const failed = applyModelEdits(edits, registry, fakeSync(), null);

    expect(failed).toEqual([]);
    const model = models.get("doc-a")!;
    expect(model.pushEditOperations).toHaveBeenCalledTimes(1);
    expect(model.pushEditOperations).toHaveBeenCalledWith(
      null,
      [
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 4,
          },
          text: "hi",
        },
      ],
      expect.any(Function),
    );
  });

  it("records an undo step (pushEditOperations, not the undo-less applyEdits)", () => {
    // The seam must go through pushEditOperations so Ctrl+Z can revert
    // LSP-driven edits (F2 rename, code actions). Pin the undo idiom: null
    // cursor state in, null cursor state out (programmatic, non-tracking
    // edits). The fake model deliberately has NO applyEdits method — the
    // applier calling it would throw here.
    const { registry, models } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a" },
    });
    applyModelEdits(
      [{ uri: "file:///a.typ", edits: [te(0, 0, 0, 1, "x")] }],
      registry,
      fakeSync(),
      null,
    );
    const model = models.get("doc-a")!;
    const call = model.pushEditOperations.mock.calls[0];
    expect(call[0]).toBeNull();
    expect((call[2] as () => null)()).toBeNull();
  });

  it("reports a URI as failed when it does not resolve to an open doc", () => {
    const { registry } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a" },
    });
    const edits = [
      { uri: "file:///closed.typ", edits: [te(0, 0, 0, 1, "x")] },
    ] as unknown as PlannedModelEdit[];
    expect(applyModelEdits(edits, registry, fakeSync(), null)).toEqual([
      "file:///closed.typ",
    ]);
  });

  it("reports a URI as failed when the registry has no model entry for the id", () => {
    // resolveDocumentId returns an id, but getModel returns undefined (e.g. the
    // doc is in the store but not yet opened in the registry).
    const registry: FakeRegistry = {
      resolveDocumentId: vi.fn(() => "doc-ghost"),
      getModel: vi.fn(() => undefined),
      __models: new Map(),
    };
    const edits = [
      { uri: "file:///ghost.typ", edits: [te(0, 0, 0, 1, "x")] },
    ] as unknown as PlannedModelEdit[];
    expect(applyModelEdits(edits, registry, fakeSync(), null)).toEqual([
      "file:///ghost.typ",
    ]);
  });

  it("applies edits to MULTIPLE models independently", () => {
    const { registry, models } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a" },
      b: { uri: "file:///b.typ", id: "doc-b" },
    });
    const edits = [
      { uri: "file:///a.typ", edits: [te(0, 0, 0, 1, "A")] },
      { uri: "file:///b.typ", edits: [te(1, 0, 1, 1, "B")] },
    ] as unknown as PlannedModelEdit[];
    applyModelEdits(edits, registry, fakeSync(), null);
    expect(models.get("doc-a")!.pushEditOperations).toHaveBeenCalledOnce();
    expect(models.get("doc-b")!.pushEditOperations).toHaveBeenCalledOnce();
  });

  it("syncs INACTIVE models through the injected store/backend sync", () => {
    // Regression pin (P0-1): the editor's content-change listener only
    // observes the ATTACHED model. An LSP edit on any other open model must be
    // explicitly pushed into documentsStore + updateText — otherwise a later
    // save of that background doc writes stale pre-edit text to disk.
    const { registry } = fakeRegistry({
      b: { uri: "file:///b.typ", id: "doc-b", value: "renamed content" },
    });
    const sync = fakeSync();
    applyModelEdits(
      [{ uri: "file:///b.typ", edits: [te(0, 0, 0, 1, "R")] }],
      registry,
      sync,
      "doc-active", // doc-b is NOT the active tab
    );
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith("doc-b", "renamed content");
  });

  it("does NOT sync the ACTIVE model (its change flows through editor onChange)", () => {
    // Double-driving the active doc would double-bump revisions and race the
    // debounced compile push — the active path belongs to handleTextChanged.
    const { registry } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a", value: "typed" },
    });
    const sync = fakeSync();
    applyModelEdits(
      [{ uri: "file:///a.typ", edits: [te(0, 0, 0, 1, "T")] }],
      registry,
      sync,
      "doc-a", // active
    );
    expect(sync).not.toHaveBeenCalled();
  });

  it("reads back post-edit text AFTER pushEditOperations (getValue ordering)", () => {
    // The sync must observe the post-edit text; pin that getValue is invoked
    // after the edit lands, not before.
    const { registry, models } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a", value: "post-edit" },
    });
    const order: string[] = [];
    models.get("doc-a")!.pushEditOperations.mockImplementation(() => {
      order.push("edit");
    });
    models.get("doc-a")!.getValue.mockImplementation(() => {
      order.push("read");
      return "post-edit";
    });
    applyModelEdits(
      [{ uri: "file:///a.typ", edits: [te(0, 0, 0, 1, "T")] }],
      registry,
      fakeSync(),
      null,
    );
    expect(order).toEqual(["edit", "read"]);
  });

  it("skips the sync for a FAILED uri (no model → nothing was applied)", () => {
    const { registry } = fakeRegistry({
      a: { uri: "file:///a.typ", id: "doc-a" },
    });
    const sync = fakeSync();
    const failed = applyModelEdits(
      [{ uri: "file:///gone.typ", edits: [te(0, 0, 0, 1, "x")] }],
      registry,
      sync,
      null,
    );
    expect(failed).toEqual(["file:///gone.typ"]);
    expect(sync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. confirmationMessage
// ---------------------------------------------------------------------------
describe("confirmationMessage", () => {
  it("returns '' for no confirmations", () => {
    expect(confirmationMessage([])).toBe("");
  });

  it("lists each dirty doc with a per-reason explanation", () => {
    const msg = confirmationMessage([
      { uri: "file:///a.typ", reason: "dirty-overwrite" },
      { uri: "file:///b.typ", reason: "delete-dirty" },
      { uri: "file:///c.typ", reason: "rename-overwrite" },
    ]);
    expect(msg).toContain("3 documents");
    expect(msg).toContain("file:///a.typ — this would overwrite its unsaved edits");
    expect(msg).toContain(
      "file:///b.typ — deleting this file would discard unsaved edits",
    );
    expect(msg).toContain(
      "file:///c.typ — moving onto this file would overwrite its unsaved edits",
    );
    expect(msg).toContain("Apply anyway?");
  });

  it("uses singular wording for one confirmation", () => {
    expect(
      confirmationMessage([
        { uri: "file:///a.typ", reason: "dirty-overwrite" },
      ]),
    ).toContain("a document");
  });
});

// ---------------------------------------------------------------------------
// 3. executeWorkspaceEditPlan — orchestration / ordering / result shapes
// ---------------------------------------------------------------------------
describe("executeWorkspaceEditPlan", () => {
  it("aborts (applied:false) on a declined confirmation, BEFORE applying anything", async () => {
    const applyModels = vi.fn(() => []);
    const applyDisk = vi.fn(async () => [] as DiskApplyFailure[]);
    const plan = {
      applyToModel: [{ uri: "file:///a.typ", edits: [] } as PlannedModelEdit],
      applyToDisk: [] as PlannedDiskEdit[],
      needsConfirmation: [
        { uri: "file:///a.typ", reason: "dirty-overwrite" as const },
      ],
    };
    const result = await executeWorkspaceEditPlan(plan, {
      confirm: async () => false, // declined
      applyModels,
      applyDisk,
    });
    expect(result).toEqual({
      applied: false,
      failureReason: "user declined overwrite",
    });
    // NOTHING was applied — the gate fires first.
    expect(applyModels).not.toHaveBeenCalled();
    expect(applyDisk).not.toHaveBeenCalled();
  });

  it("proceeds on an accepted confirmation and returns applied:true", async () => {
    const applyModels = vi.fn(() => []);
    const applyDisk = vi.fn(async () => [] as DiskApplyFailure[]);
    const plan = {
      applyToModel: [] as PlannedModelEdit[],
      applyToDisk: [] as PlannedDiskEdit[],
      needsConfirmation: [
        { uri: "file:///a.typ", reason: "dirty-overwrite" as const },
      ],
    };
    const result = await executeWorkspaceEditPlan(plan, {
      confirm: async () => true,
      applyModels,
      applyDisk,
    });
    expect(result).toEqual({ applied: true });
  });

  it("returns applied:true for an empty plan with no confirmations", async () => {
    const result = await executeWorkspaceEditPlan(
      {
        applyToModel: [],
        applyToDisk: [],
        needsConfirmation: [],
      },
      {
        confirm: async () => true,
        applyModels: vi.fn(() => []),
        applyDisk: vi.fn(async () => []),
      },
    );
    expect(result).toEqual({ applied: true });
  });

  it("returns applied:false when a model edit fails to resolve", async () => {
    const applyModels = vi.fn(() => ["file:///ghost.typ"]);
    const applyDisk = vi.fn(async () => [] as DiskApplyFailure[]);
    const result = await executeWorkspaceEditPlan(
      {
        applyToModel: [
          { uri: "file:///ghost.typ", edits: [] } as PlannedModelEdit,
        ],
        applyToDisk: [],
        needsConfirmation: [],
      },
      { confirm: async () => true, applyModels, applyDisk },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toMatch(/could not apply edits to open model/);
    // Disk didn't run (model failed first).
    expect(applyDisk).not.toHaveBeenCalled();
  });

  it("returns applied:false when a disk edit fails", async () => {
    const applyDisk = vi.fn(async () => [
      { uri: "file:///c.typ", reason: "boom" },
    ]);
    const result = await executeWorkspaceEditPlan(
      {
        applyToModel: [],
        applyToDisk: [
          {
            kind: "delete",
            op: { kind: "delete" as const, uri: "file:///c.typ" },
          },
        ],
        needsConfirmation: [],
      },
      {
        confirm: async () => true,
        applyModels: vi.fn(() => []),
        applyDisk,
      },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toMatch(/disk edit\(s\) failed/);
    expect(result.failureReason).toContain("file:///c.typ (boom)");
  });

  it("applies models BEFORE disk (ordering)", async () => {
    const order: string[] = [];
    const applyModels = vi.fn(() => {
      order.push("model");
      return [];
    });
    const applyDisk = vi.fn(async () => {
      order.push("disk");
      return [] as DiskApplyFailure[];
    });
    await executeWorkspaceEditPlan(
      {
        applyToModel: [{ uri: "file:///a.typ", edits: [] } as PlannedModelEdit],
        applyToDisk: [
          {
            kind: "create",
            op: { kind: "create" as const, uri: "file:///new.typ" },
          },
        ],
        needsConfirmation: [],
      },
      { confirm: async () => true, applyModels, applyDisk },
    );
    expect(order).toEqual(["model", "disk"]);
  });
});

// ---------------------------------------------------------------------------
// 4. applyDiskEdits — resource-op routing + Phase D limitations
// ---------------------------------------------------------------------------
describe("applyDiskEdits", () => {
  const ipc = {
    createEntry: vi.fn(async (_rel: string, _kind: "file" | "directory") => {}),
    renameEntry: vi.fn(async (_from: string, _to: string) => {}),
    deleteEntry: vi.fn(async (_rel: string) => {}),
  };
  const uriToRel = (uri: string): string | null => {
    // file:///ws/foo.typ → foo.typ; anything else → null (outside workspace).
    const m = /^file:\/\/\/ws\/(.+)$/.exec(uri);
    return m ? m[1] : null;
  };

  it("routes a CreateFile to createEntry with the workspace-relative path", async () => {
    const failures = await applyDiskEdits(
      [{ kind: "create", op: { kind: "create", uri: "file:///ws/new.typ" } }],
      ipc,
      uriToRel,
    );
    expect(failures).toEqual([]);
    expect(ipc.createEntry).toHaveBeenCalledWith("new.typ", "file");
  });

  it("routes a RenameFile to renameEntry", async () => {
    const failures = await applyDiskEdits(
      [
        {
          kind: "rename",
          op: {
            kind: "rename",
            oldUri: "file:///ws/old.typ",
            newUri: "file:///ws/new.typ",
          },
        },
      ],
      ipc,
      uriToRel,
    );
    expect(failures).toEqual([]);
    expect(ipc.renameEntry).toHaveBeenCalledWith("old.typ", "new.typ");
  });

  it("routes a DeleteFile to deleteEntry", async () => {
    const failures = await applyDiskEdits(
      [{ kind: "delete", op: { kind: "delete", uri: "file:///ws/gone.typ" } }],
      ipc,
      uriToRel,
    );
    expect(failures).toEqual([]);
    expect(ipc.deleteEntry).toHaveBeenCalledWith("gone.typ");
  });

  it("reports a failure for a target OUTSIDE the workspace", async () => {
    const failures = await applyDiskEdits(
      [{ kind: "create", op: { kind: "create", uri: "file:///elsewhere.typ" } }],
      ipc,
      uriToRel,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].uri).toBe("file:///elsewhere.typ");
    expect(failures[0].reason).toMatch(/outside the workspace/);
  });

  it("reports a failure for an un-open-file text edit (Phase D limitation)", async () => {
    // No applyTextEditsToDiskFile injected → the text-edit-to-disk path fails
    // loudly rather than silently dropping.
    const failures = await applyDiskEdits(
      [{ kind: "text", uri: "file:///ws/c.typ", edits: [te(0, 0, 0, 1, "x")] }],
      ipc,
      uriToRel,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/not yet supported/);
  });

  it("applies an un-open-file text edit WHEN applyTextEditsToDiskFile is provided", async () => {
    const applyTextEditsToDiskFile = vi.fn(async () => {});
    const failures = await applyDiskEdits(
      [{ kind: "text", uri: "file:///ws/c.typ", edits: [te(0, 0, 0, 1, "x")] }],
      { ...ipc, applyTextEditsToDiskFile },
      uriToRel,
    );
    expect(failures).toEqual([]);
    expect(applyTextEditsToDiskFile).toHaveBeenCalledWith("file:///ws/c.typ", [
      te(0, 0, 0, 1, "x"),
    ]);
  });

  it("captures an IPC rejection as a failure (does not throw)", async () => {
    const failingIpc = {
      ...ipc,
      deleteEntry: vi.fn(async () => {
        throw new Error("delete_blocked");
      }),
    };
    const failures = await applyDiskEdits(
      [{ kind: "delete", op: { kind: "delete", uri: "file:///ws/gone.typ" } }],
      failingIpc,
      uriToRel,
    );
    expect(failures).toEqual([
      { uri: "file:///ws/gone.typ", reason: "delete_blocked" },
    ]);
  });
});

import { toEntryKindWire } from "../workspaceEditApplier";

describe("toEntryKindWire (resource-op kind → backend EntryKind)", () => {
  it("maps the LSP 'directory' literal onto the backend 'dir' wire enum", () => {
    expect(toEntryKindWire("directory")).toBe("dir");
    expect(toEntryKindWire("file")).toBe("file");
  });
});
