import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  DocumentOrigin,
  OpenedDocument,
  ReboundDoc,
} from "../../../lib/types";

// The "rename chain drives migrateModelForSaveAs" describe block (below) needs
// the registry mocked so the orchestration's `migrateUri`/`getModel` can be
// asserted without standing up real Monaco models. `vi.mock` is hoisted ABOVE
// the static imports below, so they see the mocked registry — same pattern as
// saveAsMigration.test.ts. We share the spies via the module namespace import.
vi.mock("../monacoModelRegistry", () => {
  const getModel = vi.fn();
  const migrateUri = vi.fn();
  const saveViewState = vi.fn();
  const resolveDocumentId = vi.fn();
  return {
    monacoModelRegistry: { getModel, migrateUri, saveViewState, resolveDocumentId },
  };
});

import { useDocumentsStore } from "../../../store/documentsStore";
import {
  detectOriginTransition,
  originSignature,
  originsEqual,
  migrateModelForSaveAs,
} from "../saveAsMigration";
import * as registryMockNS from "../monacoModelRegistry";

/**
 * Spec §12.1 (文件重命名) — Task 10 Part A.
 *
 * The rename→migration chain is:
 *
 *   backend `rename_entry`
 *     → `docs_rebound` event (one entry per rebound doc, batched for a dir)
 *     → `useTypstCompile`'s `onDocsRebound` handler calls `rebindDocPath` for each
 *     → `rebindDocPath` updates `origin` (NEW object, new `path`, same variant +
 *       workspace_id/root) AND `path`/`title`
 *     → the Task 9 origin-transition effect (in `MonacoEditor.tsx`) re-runs because
 *       `originsKey` (the joined origin signatures) changed
 *     → `detectOriginTransition(prevOrigin, newOrigin)` returns the new origin
 *     → `migrateModelForSaveAs(id, newOrigin, editor?)` migrates the registry model
 *
 * This test pins the LOGIC the effect consumes — it does NOT mount the React
 * component (jsdom can't run real Monaco). The two things that MUST hold for the
 * effect to fire + migrate the right docs are:
 *
 *   1. `rebindDocPath` produces a NEW origin object whose `originSignature`
 *      DIFFERS from the pre-rename origin (so `originsKey` changes + the effect
 *      re-runs). For both `workspaceFile` and `looseFile` the signature embeds
 *      `path`, so a rename changes it.
 *   2. `detectOriginTransition(prev, current)` returns the new origin (NOT null)
 *      after the rebind — so the effect drives a migration for exactly the
 *      renamed doc(s).
 *
 * For a DIRECTORY rename, the backend emits one `docs_rebound` entry per open
 * sub-doc; `onDocsRebound` loops over them and calls `rebindDocPath` for EACH.
 * Each call is its own store `set()`, but Zustand batches the synchronous
 * rebinds into ONE React render, so `originsKey` re-derives once with ALL N
 * renamed docs present, and the effect's per-doc loop migrates each. We model
 * that loop here by iterating the rebound payload and asserting every renamed
 * doc transitions.
 */

/** Build an `OpenedDocument` payload (as the backend would emit) for seeding. */
function openedDoc(over: Partial<OpenedDocument> = {}): OpenedDocument {
  return {
    content: "old",
    id: "doc-1",
    path: "/ws/main.typ",
    title: "main.typ",
    dirty: false,
    origin: { kind: "untitled" },
    revision: 0,
    conflict: "none",
    kind: "typst",
    hidden: false,
    ...over,
  };
}

/**
 * Simulate the backend's `docs_rebound` payload for a list of rebound docs.
 * The Rust `ReboundDoc` serializes with `#[serde(rename_all = "camelCase")]`,
 * so the wire (and `ts_rs`-generated) shape uses `oldPath`/`newPath` — matching
 * what `useTypstCompile`'s `onDocsRebound` handler reads (`d.id`, `d.newPath`).
 */
function reboundPayload(
  entries: Array<{ id: string; newPath: string }>,
): { docs: ReboundDoc[] } {
  return {
    docs: entries.map((e) => ({
      id: e.id,
      // oldPath isn't read by the frontend rebind path; only newPath is.
      oldPath: "/ignored",
      newPath: e.newPath,
    })),
  };
}

beforeEach(() => {
  useDocumentsStore.setState({ documents: {} });
});

describe("single-file rename: rebindDocPath changes origin signature (§12.1)", () => {
  it("a workspaceFile rename produces a NEW origin whose signature differs", () => {
    const oldOrigin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/old.typ",
      workspace_id: "ws-7",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "wf", path: "/ws/old.typ", origin: oldOrigin }),
    );
    const prevOrigin = useDocumentsStore.getState().documents["wf"].origin;
    const prevSig = originSignature(prevOrigin);

    // Simulate the docs_rebound → onDocsRebound → rebindDocPath chain.
    const payload = reboundPayload([
      { id: "wf", newPath: "/ws/renamed.typ" },
    ]);
    for (const d of payload.docs) {
      useDocumentsStore.getState().rebindDocPath(d.id, d.newPath);
    }

    const curOrigin = useDocumentsStore.getState().documents["wf"].origin;
    // New origin object identity (the store builds a new object on every set).
    expect(curOrigin).not.toBe(prevOrigin);
    // Signature differs → originsKey changes → the Task 9 effect re-runs.
    expect(originSignature(curOrigin)).not.toBe(prevSig);
    // Variant + workspace_id preserved; only path moved.
    expect(curOrigin).toEqual({
      kind: "workspaceFile",
      path: "/ws/renamed.typ",
      workspace_id: "ws-7",
    });
  });

  it("detectOriginTransition returns the NEW origin after a workspaceFile rename", () => {
    const oldOrigin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/old.typ",
      workspace_id: "ws-7",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "wf", path: "/ws/old.typ", origin: oldOrigin }),
    );
    const prev = useDocumentsStore.getState().documents["wf"].origin;

    useDocumentsStore.getState().rebindDocPath("wf", "/ws/new.typ");
    const cur = useDocumentsStore.getState().documents["wf"].origin;

    // The effect's contract: detectOriginTransition must return the new origin
    // (not null) so a migration is driven for this doc.
    expect(detectOriginTransition(prev, cur)).toStrictEqual(cur);
  });

  it("a looseFile rename produces a NEW origin whose signature differs", () => {
    const oldOrigin: DocumentOrigin = {
      kind: "looseFile",
      path: "/home/me/a.typ",
      root: "/home/me",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "lf", path: "/home/me/a.typ", origin: oldOrigin }),
    );
    const prevSig = originSignature(
      useDocumentsStore.getState().documents["lf"].origin,
    );

    useDocumentsStore.getState().rebindDocPath("lf", "/home/me/b.typ");

    const cur = useDocumentsStore.getState().documents["lf"].origin;
    expect(originSignature(cur)).not.toBe(prevSig);
    expect(cur).toEqual({
      kind: "looseFile",
      path: "/home/me/b.typ",
      root: "/home/me",
    });
  });

  it("content edits (updateContent) do NOT look like a rename transition", () => {
    const origin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/main.typ",
      workspace_id: "ws-1",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "wf", origin, content: "a" }),
    );
    const prev = useDocumentsStore.getState().documents["wf"].origin;

    // A content edit rebuilds the documents map but leaves origin untouched.
    useDocumentsStore.getState().updateContent("wf", "new content");
    const cur = useDocumentsStore.getState().documents["wf"].origin;

    expect(originsEqual(prev, cur)).toBe(true);
    expect(detectOriginTransition(prev, cur)).toBeNull();
  });
});

describe("directory rename: each open sub-doc transitions (§12.1 batch)", () => {
  it("a directory rename emitting N docs_rebound entries transitions ALL N docs", () => {
    // Seed three open docs under /ws/src/ — a directory rename to /ws/src2/
    // rebinds each to its matching path under the new dir.
    const wsId = "ws-1";
    const docs = [
      {
        id: "d1",
        path: "/ws/src/a.typ",
        origin: {
          kind: "workspaceFile" as const,
          path: "/ws/src/a.typ",
          workspace_id: wsId,
        },
      },
      {
        id: "d2",
        path: "/ws/src/sub/b.typ",
        origin: {
          kind: "workspaceFile" as const,
          path: "/ws/src/sub/b.typ",
          workspace_id: wsId,
        },
      },
      {
        id: "d3",
        path: "/ws/src/c.typ",
        origin: {
          kind: "workspaceFile" as const,
          path: "/ws/src/c.typ",
          workspace_id: wsId,
        },
      },
    ];
    for (const d of docs) {
      useDocumentsStore.getState().openDocument(
        openedDoc({ id: d.id, path: d.path, origin: d.origin }),
      );
    }

    // Snapshot the pre-rename origins (the effect's prevOriginsRef equivalent).
    const state = useDocumentsStore.getState().documents;
    const prev: Record<string, DocumentOrigin> = {
      d1: state.d1.origin,
      d2: state.d2.origin,
      d3: state.d3.origin,
    };
    const prevSigs = Object.fromEntries(
      Object.entries(prev).map(([id, o]) => [id, originSignature(o)]),
    );

    // Simulate the batched docs_rebound payload + the onDocsRebound loop. The
    // backend rebinds EVERY open doc under the renamed dir, so the payload
    // carries one entry per sub-doc.
    const payload = reboundPayload([
      { id: "d1", newPath: "/ws/src2/a.typ" },
      { id: "d2", newPath: "/ws/src2/sub/b.typ" },
      { id: "d3", newPath: "/ws/src2/c.typ" },
    ]);
    for (const d of payload.docs) {
      useDocumentsStore.getState().rebindDocPath(d.id, d.newPath);
    }

    // After the batch, EVERY renamed doc's origin must have transitioned — i.e.
    // detectOriginTransition returns a non-null new origin for each. This is the
    // exact predicate the Task 9 effect's per-doc loop uses to decide which docs
    // to migrate, so N non-null transitions ⇒ N migrations.
    const after = useDocumentsStore.getState().documents;
    const transitions: Array<{ id: string; newOrigin: DocumentOrigin }> = [];
    for (const d of docs) {
      const t = detectOriginTransition(prev[d.id], after[d.id].origin);
      expect(t).not.toBeNull();
      transitions.push({ id: d.id, newOrigin: t as DocumentOrigin });
      // The new origin points at the renamed path with variant + workspace_id kept.
      expect(originSignature(after[d.id].origin)).not.toBe(prevSigs[d.id]);
    }
    expect(transitions).toHaveLength(3);
    // Each migration target carries the correct new path.
    expect(transitions.find((t) => t.id === "d1")!.newOrigin).toEqual({
      kind: "workspaceFile",
      path: "/ws/src2/a.typ",
      workspace_id: wsId,
    });
    expect(transitions.find((t) => t.id === "d2")!.newOrigin).toEqual({
      kind: "workspaceFile",
      path: "/ws/src2/sub/b.typ",
      workspace_id: wsId,
    });
    expect(transitions.find((t) => t.id === "d3")!.newOrigin).toEqual({
      kind: "workspaceFile",
      path: "/ws/src2/c.typ",
      workspace_id: wsId,
    });
  });

  it("a directory rename leaves UNRELATED docs (not under the dir) without a transition", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "in-dir",
        path: "/ws/src/a.typ",
        origin: {
          kind: "workspaceFile",
          path: "/ws/src/a.typ",
          workspace_id: "ws-1",
        },
      }),
    );
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "outside",
        path: "/ws/other/b.typ",
        origin: {
          kind: "workspaceFile",
          path: "/ws/other/b.typ",
          workspace_id: "ws-1",
        },
      }),
    );
    const prevOutside = useDocumentsStore.getState().documents.outside.origin;

    // The backend only rebinds docs UNDER the renamed dir; the payload therefore
    // omits the unrelated doc.
    const payload = reboundPayload([
      { id: "in-dir", newPath: "/ws/src2/a.typ" },
    ]);
    for (const d of payload.docs) {
      useDocumentsStore.getState().rebindDocPath(d.id, d.newPath);
    }

    // Only the in-dir doc transitions; the outside doc's origin is byte-identical
    // (so detectOriginTransition returns null for it — no spurious migration).
    expect(
      detectOriginTransition(
        prevOutside,
        useDocumentsStore.getState().documents.outside.origin,
      ),
    ).toBeNull();
  });
});

describe("rename chain drives migrateModelForSaveAs (§12.1 / §11)", () => {
  // The registry mock is hoisted to the top of the file (above the static
  // imports of `migrateModelForSaveAs` and the registry namespace), so the
  // orchestration sees the mocked registry. We read the spies back via the
  // namespace import. Same pattern as saveAsMigration.test.ts.
  interface MockEntry {
    model: unknown;
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
  const registryMock = registryMockNS as unknown as {
    monacoModelRegistry: MockRegistry;
  };

  beforeEach(() => {
    registryMock.monacoModelRegistry.getModel.mockReset();
    registryMock.monacoModelRegistry.migrateUri.mockReset();
    registryMock.monacoModelRegistry.saveViewState.mockReset();
    registryMock.monacoModelRegistry.resolveDocumentId.mockReset();
  });

  it("the full chain (rebind → detect → migrate) migrates a renamed workspaceFile's model", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "wf",
        path: "/ws/old.typ",
        origin: {
          kind: "workspaceFile",
          path: "/ws/old.typ",
          workspace_id: "ws-7",
        },
      }),
    );
    const prev = useDocumentsStore.getState().documents.wf.origin;

    // docs_rebound → rebindDocPath.
    useDocumentsStore.getState().rebindDocPath("wf", "/ws/new.typ");
    const cur = useDocumentsStore.getState().documents.wf.origin;

    // The Task 9 effect's per-doc decision + call. Non-active (no editor) ⇒
    // registry-only migration, exactly as the effect passes `null` for a
    // background tab.
    const transition = detectOriginTransition(prev, cur);
    expect(transition).not.toBeNull();
    const oldEntry: MockEntry = {
      model: { __old: true },
      uri: "file:///ws/old.typ",
      documentId: "wf",
      viewState: null,
    };
    const newEntry: MockEntry = {
      model: { __new: true },
      uri: "file:///ws/new.typ",
      documentId: "wf",
      viewState: null,
    };
    registryMock.monacoModelRegistry.getModel.mockReturnValue(oldEntry);
    registryMock.monacoModelRegistry.migrateUri.mockReturnValue(newEntry);

    const result = migrateModelForSaveAs("wf", transition as DocumentOrigin, null);

    expect(result).toEqual({ ok: true });
    expect(registryMock.monacoModelRegistry.migrateUri).toHaveBeenCalledWith(
      "wf",
      cur,
    );
  });

  it("a directory rename drives N migrations (one migrateModelForSaveAs per renamed doc)", () => {
    const ids = ["d1", "d2", "d3"];
    const oldPaths = [
      "/ws/src/a.typ",
      "/ws/src/sub/b.typ",
      "/ws/src/c.typ",
    ];
    const newPaths = [
      "/ws/src2/a.typ",
      "/ws/src2/sub/b.typ",
      "/ws/src2/c.typ",
    ];
    for (let i = 0; i < ids.length; i++) {
      useDocumentsStore.getState().openDocument(
        openedDoc({
          id: ids[i],
          path: oldPaths[i],
          origin: {
            kind: "workspaceFile",
            path: oldPaths[i],
            workspace_id: "ws-1",
          },
        }),
      );
    }
    const prev: Record<string, DocumentOrigin> = {};
    for (const id of ids) {
      prev[id] = useDocumentsStore.getState().documents[id].origin;
    }

    // Batched rebinds — the onDocsRebound loop.
    for (let i = 0; i < ids.length; i++) {
      useDocumentsStore.getState().rebindDocPath(ids[i], newPaths[i]);
    }

    // The effect's per-doc loop: for EACH transitioned doc, call migrate. We
    // model that loop here and assert migrateUri fires once per doc with the
    // doc's NEW origin.
    const after = useDocumentsStore.getState().documents;
    registryMock.monacoModelRegistry.getModel.mockImplementation(
      (id: string) => ({
        model: { __old: id },
        uri: `file:///${id}`,
        documentId: id,
        viewState: null,
      }),
    );
    registryMock.monacoModelRegistry.migrateUri.mockImplementation(
      (id: string) => ({
        model: { __new: id },
        uri: `file:///${id}-new`,
        documentId: id,
        viewState: null,
      }),
    );

    let migrated = 0;
    for (const id of ids) {
      const t = detectOriginTransition(prev[id], after[id].origin);
      if (t === null) continue;
      migrateModelForSaveAs(id, t, null);
      migrated++;
    }
    expect(migrated).toBe(3);
    expect(registryMock.monacoModelRegistry.migrateUri).toHaveBeenCalledTimes(3);
    expect(newPaths).toEqual(
      expect.arrayContaining(
        registryMock.monacoModelRegistry.migrateUri.mock.calls.map(
          // Each call's 2nd arg is the new origin; pull its path.
          (c: unknown[]) =>
            (c[1] as DocumentOrigin).kind === "workspaceFile"
              ? (c[1] as { path: string }).path
              : "",
        ),
      ),
    );
  });
});
