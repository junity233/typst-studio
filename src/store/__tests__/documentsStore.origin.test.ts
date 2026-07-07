import { describe, it, expect, beforeEach } from "vitest";
import {
  useDocumentsStore,
  documentFromOpened,
} from "../documentsStore";
import type { DocumentOrigin, OpenedDocument } from "../../lib/types";

/**
 * Authoritative `origin` on the frontend `Document` (spec §17 / §8.2). The LSP
 * refactor needs `DocumentOrigin` available on the domain object so
 * `documentUri.ts` can convert it to the URI Monaco + Tinymist both see,
 * without a round-trip. These tests pin the origin-coherence rules:
 *
 * - `documentFromOpened` seeds `origin` from the backend payload.
 * - `markSaved` (Save As) transitions `untitled` → `looseFile` (new path +
 *   parent-dir root).
 * - `rebindDocPath` updates the inner `origin.path` for `workspaceFile` /
 *   `looseFile` (keeping `workspace_id` / `root`).
 * - the other mutations (`updateContent` / `setPages` / `setStatus` /
 *   `setConflict`) MUST NOT disturb `origin`.
 */

/** Build an `OpenedDocument` payload (as the backend would emit) for seeding. */
function openedDoc(over: Partial<OpenedDocument> = {}): OpenedDocument {
  return {
    content: "old",
    id: "doc-1",
    path: "/x/main.typ",
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

describe("documentFromOpened preserves origin (§17)", () => {
  it("seeds origin from the backend payload (workspaceFile)", () => {
    const origin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/main.typ",
      workspace_id: "ws-1",
    };
    const doc = documentFromOpened(openedDoc({ origin }));
    expect(doc.origin).toEqual(origin);
  });

  it("seeds origin from the backend payload (looseFile)", () => {
    const origin: DocumentOrigin = {
      kind: "looseFile",
      path: "/home/me/notes.typ",
      root: "/home/me",
    };
    const doc = documentFromOpened(openedDoc({ origin }));
    expect(doc.origin).toEqual(origin);
  });

  it("seeds origin from the backend payload (untitled)", () => {
    const doc = documentFromOpened(openedDoc({ origin: { kind: "untitled" } }));
    expect(doc.origin).toEqual({ kind: "untitled" });
  });
});

describe("markSaved transitions origin on Save As (§17)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("transitions untitled → looseFile with the new path and parent-dir root", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "u1",
        origin: { kind: "untitled" },
        content: "hello",
      }),
    );
    useDocumentsStore.getState().markSaved("u1", "/home/me/saved.typ");

    const doc = useDocumentsStore.getState().documents["u1"];
    expect(doc.path).toBe("/home/me/saved.typ");
    // Origin mirrors the backend: untitled becomes a looseFile rooted at the
    // new file's parent directory (canonical absolute).
    expect(doc.origin).toEqual({
      kind: "looseFile",
      path: "/home/me/saved.typ",
      root: "/home/me",
    });
  });

  it("keeps the origin variant when the path is unchanged (plain save)", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "wf1",
        path: "/ws/main.typ",
        origin: {
          kind: "workspaceFile",
          path: "/ws/main.typ",
          workspace_id: "ws-1",
        },
      }),
    );
    useDocumentsStore.getState().markSaved("wf1", "/ws/main.typ");
    const doc = useDocumentsStore.getState().documents["wf1"];
    // Same path → origin variant preserved (still a workspaceFile).
    expect(doc.origin).toEqual({
      kind: "workspaceFile",
      path: "/ws/main.typ",
      workspace_id: "ws-1",
    });
  });

  it("transitions looseFile to a new looseFile path (Save As to another location)", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "lf1",
        path: "/a/b.typ",
        origin: { kind: "looseFile", path: "/a/b.typ", root: "/a" },
      }),
    );
    useDocumentsStore.getState().markSaved("lf1", "/c/d.typ");
    const doc = useDocumentsStore.getState().documents["lf1"];
    // Save As to a different folder → new looseFile with the new parent root.
    expect(doc.origin).toEqual({
      kind: "looseFile",
      path: "/c/d.typ",
      root: "/c",
    });
  });
});

describe("rebindDocPath updates origin.path (§17 / §6.4)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("updates origin.path for workspaceFile (keeps workspace_id)", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "wf2",
        path: "/ws/old.typ",
        origin: {
          kind: "workspaceFile",
          path: "/ws/old.typ",
          workspace_id: "ws-7",
        },
      }),
    );
    useDocumentsStore.getState().rebindDocPath("wf2", "/ws/new.typ");
    const doc = useDocumentsStore.getState().documents["wf2"];
    expect(doc.origin).toEqual({
      kind: "workspaceFile",
      path: "/ws/new.typ",
      workspace_id: "ws-7",
    });
    expect(doc.path).toBe("/ws/new.typ");
  });

  it("updates origin.path for looseFile (keeps root)", () => {
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "lf2",
        path: "/home/me/old.typ",
        origin: {
          kind: "looseFile",
          path: "/home/me/old.typ",
          root: "/home/me",
        },
      }),
    );
    useDocumentsStore.getState().rebindDocPath("lf2", "/home/me/new.typ");
    const doc = useDocumentsStore.getState().documents["lf2"];
    expect(doc.origin).toEqual({
      kind: "looseFile",
      path: "/home/me/new.typ",
      root: "/home/me",
    });
  });

  it("is a no-op for an untitled doc (path + origin unchanged)", () => {
    // Untitled docs have no disk path to rebind. The backend never sends
    // docs_rebound for an untitled doc, but rebindDocPath guards anyway so a
    // stray call cannot create an incoherent mirror (path set, origin still
    // untitled).
    useDocumentsStore.getState().openDocument(
      openedDoc({
        id: "u2",
        path: null,
        origin: { kind: "untitled" },
        title: "Untitled-1",
      }),
    );
    useDocumentsStore.getState().rebindDocPath("u2", "/somewhere/renamed.typ");
    const doc = useDocumentsStore.getState().documents["u2"];
    expect(doc.path).toBe(null);
    expect(doc.origin).toEqual({ kind: "untitled" });
    // Title is also derived from path; ensure it wasn't overwritten.
    expect(doc.title).toBe("Untitled-1");
  });
});

describe("origin is undisturbed by non-path mutations (§17)", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("updateContent does not change origin", () => {
    const origin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/main.typ",
      workspace_id: "ws-1",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "m1", origin, content: "a" }),
    );
    useDocumentsStore.getState().updateContent("m1", "b");
    expect(useDocumentsStore.getState().documents["m1"].origin).toEqual(origin);
  });

  it("setPages does not change origin", () => {
    const origin: DocumentOrigin = {
      kind: "looseFile",
      path: "/x/y.typ",
      root: "/x",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "m2", origin }),
    );
    useDocumentsStore.getState().setPages("m2", 0, ["<svg/>"], [], []);
    expect(useDocumentsStore.getState().documents["m2"].origin).toEqual(origin);
  });

  it("setStatus does not change origin", () => {
    const origin: DocumentOrigin = { kind: "untitled" };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "m3", origin }),
    );
    useDocumentsStore.getState().setStatus("m3", 0, "success", 10);
    expect(useDocumentsStore.getState().documents["m3"].origin).toEqual(origin);
  });

  it("setConflict does not change origin", () => {
    const origin: DocumentOrigin = {
      kind: "workspaceFile",
      path: "/ws/main.typ",
      workspace_id: "ws-1",
    };
    useDocumentsStore.getState().openDocument(
      openedDoc({ id: "m4", origin }),
    );
    useDocumentsStore.getState().setConflict("m4", "modified", "disk");
    const doc = useDocumentsStore.getState().documents["m4"];
    expect(doc.conflict).toBe("modified");
    expect(doc.origin).toEqual(origin);
  });
});
