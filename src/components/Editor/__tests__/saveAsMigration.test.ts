import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { DocumentOrigin } from "../../../lib/types";

/**
 * Spec §11 (Save As 与 URI 迁移) — Task 9.
 *
 * Two test surfaces:
 *
 * 1. PURE HELPERS — [`detectOriginTransition`](../saveAsMigration.ts),
 *    [`originsEqual`](../saveAsMigration.ts),
 *    [`originSignature`](../saveAsMigration.ts). These are Monaco-free and
 *    trivially unit-testable. They are the seam the editor's origin-transition
 *    effect uses to decide when a doc's origin changed (and thus when to drive
 *    a Save-As model migration).
 *
 * 2. ORCHESTRATION — [`migrateModelForSaveAs`](../saveAsMigration.ts). The
 *    function coordinates the registry migration + the optional editor model
 *    swap + selection/viewState restore (§11 steps 5/8/9/10). It imports the
 *    `monacoModelRegistry` singleton and takes an OPTIONAL editor (the doc may
 *    not be active). We mock the registry module so we can assert the call
 *    sequence and editor interactions without standing up real Monaco models.
 *
 * The orchestration does NOT itself fire LSP `didClose`/`didOpen` — the
 * registry's `migrateUri` swaps the underlying Monaco model (dispose old +
 * create new), and the language client's `DidOpenTextDocumentFeature`
 * (vscode-languageclient) auto-syncs from `monaco.editor.getModels()`: creating
 * a model fires `workspace.onDidOpenTextDocument` → didOpen, and disposing a
 * model fires the matching close. This is the same mechanism that auto-replays
 * all open models on LSP (re)start (see appLanguageClient.ts §9.3 note). So
 * §11 steps 6/7 happen implicitly as a consequence of model create/dispose.
 */

// ---------------------------------------------------------------------------
// Mock the registry singleton. The orchestration imports
// `monacoModelRegistry` and calls `migrateUri` / `getModel` / `saveViewState`
// on it; we replace it with a controllable spy so we can assert the call
// sequence + return a fake "new entry" whose `.model` differs from the
// "old entry" (so the orchestration detects a real migration vs a no-op).
//
// The mock is HOISTED above every declaration, so it cannot close over
// top-level lets. We therefore stash the spies on a module-level object the
// factory returns, and read them back via the imported namespace.
// ---------------------------------------------------------------------------
interface MockModel {
  __isMockModel: true;
  uri: string;
}
interface MockEntry {
  model: MockModel;
  uri: string;
  documentId: string;
  viewState: unknown;
}
interface MockRegistry {
  getModel: ReturnType<typeof vi.fn>;
  migrateUri: ReturnType<typeof vi.fn>;
  saveViewState: ReturnType<typeof vi.fn>;
  resolveDocumentId: ReturnType<typeof vi.fn>;
}

vi.mock("../monacoModelRegistry", () => {
  const getModel = vi.fn();
  const migrateUri = vi.fn();
  const saveViewState = vi.fn();
  const resolveDocumentId = vi.fn();
  const mock: MockRegistry = { getModel, migrateUri, saveViewState, resolveDocumentId };
  return { monacoModelRegistry: mock };
});

// Pull the mocked module back so the test body can configure/inspect the spies.
import * as registryMockNS from "../monacoModelRegistry";
const registryMock = registryMockNS as unknown as { monacoModelRegistry: MockRegistry };

// Import the orchestration + pure helpers AFTER the mock is in effect.
import {
  migrateModelForSaveAs,
  detectOriginTransition,
  originsEqual,
  originSignature,
} from "../saveAsMigration";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const untitled: DocumentOrigin = { kind: "untitled" };
const looseA: DocumentOrigin = {
  kind: "looseFile",
  path: "/home/me/a.typ",
  root: "/home/me",
};
const looseB: DocumentOrigin = {
  kind: "looseFile",
  path: "/home/me/b.typ",
  root: "/home/me",
};
const wsFile: DocumentOrigin = {
  kind: "workspaceFile",
  path: "/ws/x.typ",
  workspace_id: "ws-1",
};

function makeEntry(id: string, uri: string): MockEntry {
  return {
    model: { __isMockModel: true, uri },
    uri,
    documentId: id,
    viewState: { __viewState: true },
  };
}

/**
 * A minimal mock editor. Only the methods `migrateModelForSaveAs` touches:
 * `getModel`, `getSelection`, `setModel`, `restoreViewState`, `setSelection`.
 * Each is a spy so tests can assert the call sequence.
 */
function createMockEditor(currentModel: MockModel) {
  return {
    getModel: vi.fn(() => currentModel),
    getSelection: vi.fn(() => ({ __selection: true })),
    setModel: vi.fn(),
    restoreViewState: vi.fn(),
    setSelection: vi.fn(),
  } as unknown as Monaco.editor.IStandaloneCodeEditor & {
    getModel: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    restoreViewState: ReturnType<typeof vi.fn>;
    setSelection: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  registryMock.monacoModelRegistry.getModel.mockReset();
  registryMock.monacoModelRegistry.migrateUri.mockReset();
  registryMock.monacoModelRegistry.saveViewState.mockReset();
  registryMock.monacoModelRegistry.resolveDocumentId.mockReset();
});

// ---------------------------------------------------------------------------
// 1. PURE HELPERS — originSignature / originsEqual / detectOriginTransition
// ---------------------------------------------------------------------------
describe("originSignature / originsEqual / detectOriginTransition (pure)", () => {
  it("originSignature is deterministic for the same origin", () => {
    expect(originSignature(looseA)).toBe(originSignature(looseA));
    expect(originSignature(untitled)).toBe(originSignature({ kind: "untitled" }));
  });

  it("originSignature differs when path / root / workspace_id differ", () => {
    expect(originSignature(looseA)).not.toBe(originSignature(looseB));
    expect(originSignature(looseA)).not.toBe(originSignature(untitled));
    const wsOther: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/x.typ",
      workspace_id: "ws-2",
    };
    expect(originSignature(wsFile)).not.toBe(originSignature(wsOther));
  });

  it("originsEqual returns true for structurally-equal origins", () => {
    expect(originsEqual(untitled, { kind: "untitled" })).toBe(true);
    expect(originsEqual(looseA, { ...looseA })).toBe(true);
    expect(originsEqual(wsFile, { ...wsFile })).toBe(true);
  });

  it("originsEqual returns false when any field differs", () => {
    expect(originsEqual(untitled, looseA)).toBe(false);
    expect(originsEqual(looseA, looseB)).toBe(false);
    const wsOther: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/x.typ",
      workspace_id: "ws-2",
    };
    expect(originsEqual(wsFile, wsOther)).toBe(false);
    // A looseFile and workspaceFile at the SAME path are NOT equal — they
    // differ in kind, which matters for LSP folder association.
    const looseAtWsPath: DocumentOrigin = {
      kind: "looseFile",
      path: "/ws/x.typ",
      root: "/ws",
    };
    expect(originsEqual(wsFile, looseAtWsPath)).toBe(false);
  });

  it("detectOriginTransition returns null when the origin did NOT change", () => {
    expect(detectOriginTransition(untitled, { kind: "untitled" })).toBeNull();
    expect(detectOriginTransition(looseA, { ...looseA })).toBeNull();
  });

  it("detectOriginTransition returns the NEW origin when it changed", () => {
    // untitled → looseFile (a true Save As).
    expect(detectOriginTransition(untitled, looseA)).toStrictEqual(looseA);
    // looseFile → looseFile at a new path (Save As to a different name).
    expect(detectOriginTransition(looseA, looseB)).toStrictEqual(looseB);
    // workspaceFile → looseFile (a Save As out of the workspace).
    expect(detectOriginTransition(wsFile, looseA)).toStrictEqual(looseA);
  });
});

// ---------------------------------------------------------------------------
// 2. migrateModelForSaveAs — orchestration
// ---------------------------------------------------------------------------
describe("migrateModelForSaveAs (§11 orchestration)", () => {
  it("returns { ok: false, reason: 'not-open' } when the doc has no registry entry", () => {
    registryMock.monacoModelRegistry.getModel.mockReturnValue(undefined);

    const result = migrateModelForSaveAs("ghost", looseA);

    expect(result).toEqual({ ok: false, reason: "not-open" });
    // Migrate MUST NOT have been attempted on an unknown id.
    expect(registryMock.monacoModelRegistry.migrateUri).not.toHaveBeenCalled();
  });

  it("active-doc migration: migrates registry, swaps editor.setModel, restores viewState + selection", () => {
    const oldEntry = makeEntry("doc-1", "untitled:/doc-1.typ");
    const newEntry = makeEntry("doc-1", "file:///home/me/a.typ");
    registryMock.monacoModelRegistry.getModel.mockReturnValue(oldEntry);
    registryMock.monacoModelRegistry.migrateUri.mockReturnValue(newEntry);

    const editor = createMockEditor(oldEntry.model);

    const result = migrateModelForSaveAs("doc-1", looseA, editor);

    expect(result).toEqual({ ok: true });
    // §11 step 4: the editor's current view state was freshened onto the entry
    // BEFORE migrateUri (so the migration preserves the CURRENT scroll/cursor,
    // not the last-tab-switch snapshot).
    expect(registryMock.monacoModelRegistry.saveViewState).toHaveBeenCalledWith(
      "doc-1",
      editor,
    );
    expect(registryMock.monacoModelRegistry.migrateUri).toHaveBeenCalledWith(
      "doc-1",
      looseA,
    );
    // §11 step 8: editor.setModel swapped to the NEW model.
    expect(editor.setModel).toHaveBeenCalledTimes(1);
    expect(editor.setModel).toHaveBeenCalledWith(newEntry.model);
    // §11 step 9: view state + selection restored.
    expect(editor.restoreViewState).toHaveBeenCalledWith(newEntry.viewState);
    expect(editor.setSelection).toHaveBeenCalledTimes(1);
  });

  it("non-active-doc migration: migrates the registry but does NOT touch any editor", () => {
    const oldEntry = makeEntry("doc-2", "untitled:/doc-2.typ");
    const newEntry = makeEntry("doc-2", "file:///home/me/b.typ");
    registryMock.monacoModelRegistry.getModel.mockReturnValue(oldEntry);
    registryMock.monacoModelRegistry.migrateUri.mockReturnValue(newEntry);

    // No editor passed → registry-only migration (non-active doc, or no live
    // editor yet). The model is replaced in the registry; the editor swap is
    // the caller's responsibility when/if the doc becomes active.
    const result = migrateModelForSaveAs("doc-2", looseB);

    expect(result).toEqual({ ok: true });
    expect(registryMock.monacoModelRegistry.migrateUri).toHaveBeenCalledWith(
      "doc-2",
      looseB,
    );
    // No editor interactions whatsoever.
    expect(registryMock.monacoModelRegistry.saveViewState).not.toHaveBeenCalled();
  });

  it("no-op when the new origin produces the SAME uri (re-save of the same path)", () => {
    const oldEntry = makeEntry("doc-3", "file:///home/me/a.typ");
    // migrateUri returns the SAME entry (same model identity) when the URI is
    // unchanged — mirrors the real registry's same-uri no-op branch.
    registryMock.monacoModelRegistry.getModel.mockReturnValue(oldEntry);
    registryMock.monacoModelRegistry.migrateUri.mockReturnValue(oldEntry);

    const editor = createMockEditor(oldEntry.model);

    const result = migrateModelForSaveAs("doc-3", looseA, editor);

    // No real migration: the editor MUST be left alone (no setModel churn).
    expect(result).toEqual({ ok: true, reason: "no-op" });
    expect(editor.setModel).not.toHaveBeenCalled();
    expect(editor.restoreViewState).not.toHaveBeenCalled();
    expect(editor.setSelection).not.toHaveBeenCalled();
    // migrateUri was still called (the orchestration can't know upfront it'll
    // be a no-op — the registry decides). saveViewState too, since an editor
    // was passed and we freshen defensively before migrating.
    expect(registryMock.monacoModelRegistry.migrateUri).toHaveBeenCalledWith(
      "doc-3",
      looseA,
    );
  });

  it("active-doc migration with a null editor reference is registry-only (defensive)", () => {
    const oldEntry = makeEntry("doc-4", "untitled:/doc-4.typ");
    const newEntry = makeEntry("doc-4", "file:///home/me/a.typ");
    registryMock.monacoModelRegistry.getModel.mockReturnValue(oldEntry);
    registryMock.monacoModelRegistry.migrateUri.mockReturnValue(newEntry);

    // Passing null/undefined editor must not throw and must not call editor
    // methods. (The effect may pass `null` when getEditor() returns null —
    // e.g. during the brief window before the editor has started.)
    const result = migrateModelForSaveAs("doc-4", looseA, null);

    expect(result).toEqual({ ok: true });
    expect(registryMock.monacoModelRegistry.migrateUri).toHaveBeenCalledWith(
      "doc-4",
      looseA,
    );
    expect(registryMock.monacoModelRegistry.saveViewState).not.toHaveBeenCalled();
  });

  it("after migration the OLD uri no longer resolves (§11: stale-URI diagnostics dropped)", () => {
    // This pins the §11 contract that the bridge relies on: once a doc has
    // migrated, `resolveDocumentId(oldUri)` returns null so the diagnostics
    // bridge drops any in-flight diagnostics keyed on the stale URI. The
    // orchestration itself doesn't call resolveDocumentId, but the registry's
    // migrateUri atomically removes the old uri from the uri→id map; we mock
    // that behavior here to document the contract the bridge depends on.
    const oldEntry = makeEntry("doc-5", "untitled:/doc-5.typ");
    const newEntry = makeEntry("doc-5", "file:///home/me/a.typ");
    registryMock.monacoModelRegistry.getModel.mockReturnValue(oldEntry);
    registryMock.monacoModelRegistry.migrateUri.mockImplementation(() => {
      // Simulate the registry's post-migration resolution behavior: the OLD
      // uri no longer resolves, the NEW uri does.
      registryMock.monacoModelRegistry.resolveDocumentId
        .mockReturnValueOnce(null) // old uri
        .mockReturnValueOnce("doc-5"); // new uri
      return newEntry;
    });

    migrateModelForSaveAs("doc-5", looseA);

    expect(
      registryMock.monacoModelRegistry.resolveDocumentId("untitled:/doc-5.typ"),
    ).toBeNull();
    expect(
      registryMock.monacoModelRegistry.resolveDocumentId("file:///home/me/a.typ"),
    ).toBe("doc-5");
  });
});
