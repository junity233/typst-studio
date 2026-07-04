import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";

/**
 * Spec §8 (MonacoModelRegistry), §8.4 (外部状态同步 — controlled replace +
 * anti-bounce-back), §10.5 (tab switch — view state save/restore), §11/§12
 * (Save As / rename — URI migration), §13.2 (URI→DocumentId routing).
 *
 * `MonacoModelRegistry` is a module-level registry that owns every open Monaco
 * model for the app's lifetime. A model's life == the document's open life;
 * tab switches do NOT create/destroy models (§8.3). This test file exercises
 * the registry's full public surface against a minimal hand-rolled Monaco mock.
 *
 * The real Monaco editor API cannot run under vitest+jsdom (widget CSS +
 * workers — see documentUri.test.ts header for the same constraint). We mock
 * ONLY the small surface the registry touches (`editor.createModel`,
 * `ITextModel`, `IStandaloneCodeEditor`), plus the `vscode` `Uri` helper
 * (mirrors documentUri.test.ts's faithful Uri mock). Both mocks are LOCAL to
 * this test file.
 */

// ---------------------------------------------------------------------------
// Mock 1 — `vscode` `Uri` (faithful re-implementation, same algorithm as
// documentUri.test.ts). Keep in sync with that file so the wire strings the
// registry puts on models match production `Uri.file`/`Uri.parse` output.
// ---------------------------------------------------------------------------
vi.mock("vscode", () => {
  interface UriLike {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fsPath: string;
    toString(): string;
  }

  function encodeUriComponent(seg: string): string {
    return seg.replace(
      /[#?]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  function toString(scheme: string, authority: string, path: string): string {
    let res = scheme + ":";
    if (authority.length > 0 || scheme === "file") {
      res += "//" + authority;
    }
    res += encodeUriComponent(path);
    return res;
  }

  function file(path: string): UriLike {
    const hasDrive = /^[a-zA-Z]:/.test(path);
    const hasBackslash = path.includes("\\");
    const isWindows = hasDrive || hasBackslash;
    const normalized = path.replace(/\\/g, "/");
    let uriPath: string;
    if (isWindows) {
      uriPath = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    } else {
      uriPath = normalized.startsWith("/") ? normalized : "/" + normalized;
    }
    const p = isWindows ? "/" + uriPath : uriPath;
    return {
      scheme: "file",
      authority: "",
      path: p,
      fsPath: path,
      toString: () => toString("file", "", p),
    };
  }

  function parse(uriStr: string): UriLike {
    const m =
      /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/[^/]*)?([^?#]*)?(\?[^#]*)?(#.*)?$/.exec(
        uriStr,
      );
    if (!m) {
      return {
        scheme: "",
        authority: "",
        path: uriStr,
        fsPath: uriStr,
        toString: () => uriStr,
      };
    }
    const scheme = m[1];
    const authority = m[2] ? m[2].slice(2) : "";
    const path = m[3] ?? "";
    return {
      scheme,
      authority,
      path,
      fsPath: path,
      toString: () => toString(scheme, authority, path),
    };
  }

  return { Uri: { file, parse } };
});

// ---------------------------------------------------------------------------
// Mock 2 — `@codingame/monaco-vscode-editor-api`. The registry only touches
// `editor.createModel`. Each mock model has a working getValue/setValue, a
// dispose flag, an onDidChangeContent listener registry, and a `uri` matching
// the canonical string passed at creation. We do NOT mock the entire Monaco
// surface — only what the registry reads/writes.
//
// vi.mock factories are HOISTED above every other declaration, so the factory
// CANNOT close over any top-level `let`/`const`. We therefore define the mock
// model + the createModel spy INSIDE the factory, and the factory returns a
// module whose `editor.createModel` is the spy. The test body reads
// `monacoMock.editor.createModel` to assert/ reset it.
// ---------------------------------------------------------------------------

/** A minimal mock ITextModel — only the methods/props the registry touches. */
export interface MockModel {
  getValue(): string;
  setValue(value: string): void;
  dispose(): void;
  isDisposed: boolean;
  /** Canonical URI string the model was created with. */
  uri: string;
  onDidChangeContent(listener: () => void): { dispose(): void };
}

/**
 * The live mock module object. Typed loosely — it carries the same `editor`
 * shape the registry imports, but the model/editor instances it produces are
 * our hand-rolled mocks (cast to the real Monaco types inside the registry).
 */
interface MonacoMockModule {
  editor: {
    createModel: ReturnType<typeof vi.fn>;
  };
}

vi.mock("@codingame/monaco-vscode-editor-api", () => {
  function createMockModel(content: string, uri: string): MockModel {
    const listeners: Array<() => void> = [];
    let current = content;
    const model: MockModel = {
      getValue: () => current,
      setValue: (value: string) => {
        current = value;
        // Mirror Monaco: setValue fires the content-change listeners.
        // Copy the array first — listeners may be added/removed during dispatch.
        for (const l of [...listeners]) l();
      },
      dispose: () => {
        model.isDisposed = true;
      },
      isDisposed: false,
      uri,
      onDidChangeContent: (listener: () => void) => {
        listeners.push(listener);
        return {
          dispose: () => {
            const i = listeners.indexOf(listener);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      },
    };
    return model;
  }

  const createModel = vi.fn(
    (content: string, _languageId: string, uri: { toString(): string }) =>
      createMockModel(content, uri.toString()),
  );

  const mockModule: MonacoMockModule = { editor: { createModel } };
  return mockModule;
});

// Pull the mocked module back in so the test body can reset/inspect the spy.
// (vi.mocked on the imported namespace gives us the same object the factory
// returned.)
import * as monacoMockNamespace from "@codingame/monaco-vscode-editor-api";
const monacoMock = monacoMockNamespace as unknown as MonacoMockModule;

// ---------------------------------------------------------------------------
// A minimal mock IStandaloneCodeEditor — only the methods activate()/
// saveViewState() use.
// ---------------------------------------------------------------------------
interface MockEditor {
  setModel: (model: MockModel | null) => void;
  saveViewState: () => unknown;
  restoreViewState: (state: unknown) => void;
}

function createMockEditor(): MockEditor & {
  setModelMock: ReturnType<typeof vi.fn>;
  restoreViewStateMock: ReturnType<typeof vi.fn>;
  lastSavedState: unknown;
} {
  let lastSavedState: unknown = null;
  const setModelMock = vi.fn();
  const restoreViewStateMock = vi.fn();
  return {
    setModel: setModelMock,
    saveViewState: () => {
      // Return a distinct object per call so tests can assert identity.
      lastSavedState = { __viewState: true, ts: Date.now() + Math.random() };
      return lastSavedState;
    },
    restoreViewState: restoreViewStateMock,
    setModelMock,
    restoreViewStateMock,
    get lastSavedState() {
      return lastSavedState;
    },
  };
}

// Cast helpers: the registry holds the real Monaco types (`ITextModel`,
// `IStandaloneCodeEditor`); our mocks are structurally smaller hand-rolled
// objects, so we narrow the real-typed references back to the mock interfaces
// to access mock-specific props (`MockModel.isDisposed`, `MockModel.onDidChangeContent`,
// `MockEditor.setModelMock`, …). Used ONLY in test code; production code uses
// the real types.
function asMockModel(m: Monaco.editor.ITextModel): MockModel {
  return m as unknown as MockModel;
}
function asMonacoEditor(
  e: MockEditor,
): Monaco.editor.IStandaloneCodeEditor {
  return e as unknown as Monaco.editor.IStandaloneCodeEditor;
}

// Import AFTER the vi.mock calls so the mocks are in effect.
import { monacoModelRegistry, type OpenModelOptions } from "../monacoModelRegistry";
import type { DocumentOrigin } from "../../../lib/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const untitledOrigin: DocumentOrigin = { kind: "untitled" };
const fileOrigin: DocumentOrigin = {
  kind: "looseFile",
  path: "/home/me/notes.typ",
  root: "/home/me",
};

function openOpts(
  content: string,
  origin: DocumentOrigin,
  revision = 0,
): OpenModelOptions {
  return { content, origin, revision };
}

beforeEach(() => {
  monacoModelRegistry.resetForTest();
  monacoMock.editor.createModel.mockClear();
});

// ---------------------------------------------------------------------------
// 1. openModel
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.openModel (§8.1, §8.2)", () => {
  it("creates a model and populates both id→entry and uri→id maps", () => {
    const entry = monacoModelRegistry.openModel(
      "doc-1",
      openOpts("hello", untitledOrigin, 0),
    );

    expect(monacoMock.editor.createModel).toHaveBeenCalledTimes(1);
    // Language id is "typst" (§8.1 / matches lspClient.ts).
    expect(monacoMock.editor.createModel).toHaveBeenCalledWith(
      "hello",
      "typst",
      expect.objectContaining({ toString: expect.any(Function) }),
    );
    // The mock createModel received a Uri whose toString() is the canonical URI.
    const uriArg = monacoMock.editor.createModel.mock.calls[0][2];
    expect(uriArg.toString()).toBe("untitled:/doc-1.typ");

    expect(entry.documentId).toBe("doc-1");
    expect(entry.uri).toBe("untitled:/doc-1.typ");
    expect(entry.model.getValue()).toBe("hello");
    expect(entry.viewState).toBeNull();
    expect(entry.lastSyncedRevision).toBe(0);

    // Both maps populated.
    expect(monacoModelRegistry.getModel("doc-1")).toBe(entry);
    expect(monacoModelRegistry.resolveDocumentId("untitled:/doc-1.typ")).toBe(
      "doc-1",
    );
  });

  it("is idempotent: re-open with the SAME origin/revision returns the same model (no duplicate)", () => {
    const first = monacoModelRegistry.openModel(
      "doc-1",
      openOpts("hello", untitledOrigin, 0),
    );
    const second = monacoModelRegistry.openModel(
      "doc-1",
      openOpts("hello", untitledOrigin, 0),
    );

    expect(second).toBe(first);
    // Only ONE model created across both calls.
    expect(monacoMock.editor.createModel).toHaveBeenCalledTimes(1);
    expect(monacoModelRegistry.snapshot()).toHaveLength(1);
  });

  it("creating a real file-origin model derives a file:/// URI", () => {
    const entry = monacoModelRegistry.openModel(
      "doc-2",
      openOpts("body", fileOrigin, 5),
    );
    expect(entry.uri).toBe("file:///home/me/notes.typ");
    expect(entry.lastSyncedRevision).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. getModel / resolveDocumentId
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.getModel / resolveDocumentId (§8.2, §13.2)", () => {
  beforeEach(() => {
    monacoModelRegistry.openModel("unt", openOpts("u", untitledOrigin));
    monacoModelRegistry.openModel("file", openOpts("f", fileOrigin));
  });

  it("getModel returns the entry by id and undefined for unknown", () => {
    expect(monacoModelRegistry.getModel("unt")).toBeDefined();
    expect(monacoModelRegistry.getModel("file")).toBeDefined();
    expect(monacoModelRegistry.getModel("nope")).toBeUndefined();
  });

  it("resolveDocumentId maps an untitled URI through parseUntitledUriId", () => {
    expect(monacoModelRegistry.resolveDocumentId("untitled:/unt.typ")).toBe(
      "unt",
    );
  });

  it("resolveDocumentId maps a real file URI through the uri→id map", () => {
    expect(
      monacoModelRegistry.resolveDocumentId("file:///home/me/notes.typ"),
    ).toBe("file");
  });

  it("resolveDocumentId returns null for unknown URIs", () => {
    expect(monacoModelRegistry.resolveDocumentId("file:///nope.typ")).toBeNull();
    expect(
      monacoModelRegistry.resolveDocumentId("untitled:/nope.typ"),
    ).toBeNull();
    expect(monacoModelRegistry.resolveDocumentId("garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. snapshot
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.snapshot (§9.3 replay)", () => {
  it("returns all current entries", () => {
    const a = monacoModelRegistry.openModel("a", openOpts("a", untitledOrigin));
    const b = monacoModelRegistry.openModel("b", openOpts("b", fileOrigin));

    const snap = monacoModelRegistry.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap).toContain(a);
    expect(snap).toContain(b);
  });

  it("returns a current snapshot (closing a doc after snapshot does not mutate the array)", () => {
    monacoModelRegistry.openModel("a", openOpts("a", untitledOrigin));
    const snap = monacoModelRegistry.snapshot();
    monacoModelRegistry.closeModel("a");
    // The array we got back still references the (now-disposed) entry.
    expect(snap).toHaveLength(1);
    expect(monacoModelRegistry.snapshot()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. activate
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.activate (§10.5 tab switch)", () => {
  it("saves the OUTGOING doc's view state, sets the new model, returns the target view state", () => {
    const out = monacoModelRegistry.openModel(
      "out",
      openOpts("out", untitledOrigin),
    );
    const target = monacoModelRegistry.openModel(
      "target",
      openOpts("target", fileOrigin),
    );

    const editor = createMockEditor();

    const result = monacoModelRegistry.activate(
      "target",
      asMonacoEditor(editor),
      "out",
    );

    // Outgoing view state was captured into its entry.
    expect(editor.setModelMock).toHaveBeenCalledWith(target.model);
    expect(out.viewState).not.toBeNull();
    // Returned view state is the target's (null until first save).
    expect(result.model).toBe(target.model);
    expect(result.viewState).toBe(target.viewState);
  });

  it("returns ActivateResult with the target model and its view state", () => {
    const target = monacoModelRegistry.openModel(
      "target",
      openOpts("target", fileOrigin),
    );
    // Simulate a previously-saved view state on the target entry.
    monacoModelRegistry.saveViewState(
      "target",
      asMonacoEditor(createMockEditor()),
    );
    expect(target.viewState).not.toBeNull();

    const editor = createMockEditor();
    const result = monacoModelRegistry.activate(
      "target",
      asMonacoEditor(editor),
      null,
    );

    expect(result.model).toBe(target.model);
    expect(result.viewState).toBe(target.viewState);
    // No outgoing → no view-state capture attempted on a null outgoing.
    // (activate with outgoingId=null is the very-first-activation path.)
    expect(editor.setModelMock).toHaveBeenCalledWith(target.model);
  });

  it("throws when activating an unknown documentId", () => {
    const editor = createMockEditor();
    expect(() =>
      monacoModelRegistry.activate(
        "ghost",
        asMonacoEditor(editor),
        null,
      ),
    ).toThrow();
  });

  it("does NOT capture view state for an outgoing id that isn't open", () => {
    const target = monacoModelRegistry.openModel(
      "target",
      openOpts("target", fileOrigin),
    );
    const editor = createMockEditor();
    // outgoing references an unknown doc — must not throw, just skip capture.
    expect(() =>
      monacoModelRegistry.activate(
        "target",
        asMonacoEditor(editor),
        "ghost",
      ),
    ).not.toThrow();
    expect(editor.setModelMock).toHaveBeenCalledWith(target.model);
  });
});

describe("MonacoModelRegistry.saveViewState (§10.5)", () => {
  it("stashes the editor's current view state on the entry", () => {
    monacoModelRegistry.openModel("a", openOpts("a", untitledOrigin));
    const entry = monacoModelRegistry.getModel("a")!;
    expect(entry.viewState).toBeNull();

    const editor = createMockEditor();
    monacoModelRegistry.saveViewState("a", asMonacoEditor(editor));

    expect(entry.viewState).not.toBeNull();
    expect(entry.viewState).toBe(editor.lastSavedState);
  });

  it("is a no-op for an unknown documentId", () => {
    const editor = createMockEditor();
    expect(() =>
      monacoModelRegistry.saveViewState("ghost", asMonacoEditor(editor)),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. applyExternalContent (§8.4 anti-bounce-back)
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.applyExternalContent (§8.4 controlled replace)", () => {
  it("applies new content when revision > current and updates lastSyncedRevision", () => {
    monacoModelRegistry.openModel("a", openOpts("old", untitledOrigin, 0));
    const entry = monacoModelRegistry.getModel("a")!;
    expect(entry.model.getValue()).toBe("old");

    const applied = monacoModelRegistry.applyExternalContent(
      "a",
      "new disk content",
      3,
    );

    expect(applied).toBe(true);
    expect(entry.model.getValue()).toBe("new disk content");
    expect(entry.lastSyncedRevision).toBe(3);
  });

  it("sets the suppress flag DURING the change event, then clears it", () => {
    monacoModelRegistry.openModel("a", openOpts("old", untitledOrigin, 0));

    // Register an observer that records what isSuppressingForward reports
    // while the change event is being dispatched.
    let observedDuringChange: boolean | null = null;
    const entry = monacoModelRegistry.getModel("a")!;
    asMockModel(entry.model).onDidChangeContent(() => {
      observedDuringChange = monacoModelRegistry.isSuppressingForward("a");
    });

    // Before: not suppressing.
    expect(monacoModelRegistry.isSuppressingForward("a")).toBe(false);

    monacoModelRegistry.applyExternalContent("a", "reload", 1);

    // During the setValue-fired event the flag MUST have been true.
    expect(observedDuringChange).toBe(true);
    // After the event fully dispatches: cleared.
    expect(monacoModelRegistry.isSuppressingForward("a")).toBe(false);
  });

  it("is a no-op when revision <= current (stale)", () => {
    monacoModelRegistry.openModel("a", openOpts("v0", untitledOrigin, 5));
    const entry = monacoModelRegistry.getModel("a")!;

    // equal — stale.
    expect(
      monacoModelRegistry.applyExternalContent("a", "ignored", 5),
    ).toBe(false);
    // strictly older — stale.
    expect(
      monacoModelRegistry.applyExternalContent("a", "ignored", 4),
    ).toBe(false);

    expect(entry.model.getValue()).toBe("v0");
    expect(entry.lastSyncedRevision).toBe(5);
    expect(monacoModelRegistry.isSuppressingForward("a")).toBe(false);
  });

  it("is a no-op for an unknown documentId", () => {
    expect(
      monacoModelRegistry.applyExternalContent("ghost", "x", 99),
    ).toBe(false);
  });

  it("a normal user-driven setValue is NOT suppressed (no false positive)", () => {
    monacoModelRegistry.openModel("a", openOpts("v0", untitledOrigin, 0));
    // A bare setValue NOT going through applyExternalContent must report
    // isSuppressingForward == false during its event.
    let observed: boolean | null = null;
    const entry = monacoModelRegistry.getModel("a")!;
    asMockModel(entry.model).onDidChangeContent(() => {
      observed = monacoModelRegistry.isSuppressingForward("a");
    });
    asMockModel(entry.model).setValue("user typed");
    expect(observed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. migrateUri (§11 Save As / §12 rename)
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.migrateUri (§11, §12)", () => {
  it("creates a new model at the new uri with the current text, swaps maps, disposes old, keeps viewState + revision, preserves documentId", () => {
    monacoModelRegistry.openModel(
      "a",
      openOpts("untitled body", untitledOrigin, 0),
    );
    const oldEntry = monacoModelRegistry.getModel("a")!;
    const oldModel = oldEntry.model;
    const oldUri = oldEntry.uri;

    // Give it a view state + a non-zero lastSyncedRevision.
    monacoModelRegistry.saveViewState(
      "a",
      asMonacoEditor(createMockEditor()),
    );
    monacoModelRegistry.applyExternalContent("a", "edited body", 7);
    const savedViewState = oldEntry.viewState;

    const newOrigin: DocumentOrigin = {
      kind: "looseFile",
      path: "/home/me/saved.typ",
      root: "/home/me",
    };

    const newEntry = monacoModelRegistry.migrateUri("a", newOrigin);

    // New model carries the CURRENT text (post-edit).
    expect(newEntry.model.getValue()).toBe("edited body");
    expect(newEntry.uri).toBe("file:///home/me/saved.typ");
    expect(newEntry.documentId).toBe("a"); // §11: id preserved
    expect(newEntry.lastSyncedRevision).toBe(7); // §11: revision preserved
    expect(newEntry.viewState).toBe(savedViewState); // §11: viewState preserved

    // Maps updated atomically: old uri no longer resolves; new uri does.
    expect(monacoModelRegistry.resolveDocumentId(oldUri)).toBeNull();
    expect(
      monacoModelRegistry.resolveDocumentId("file:///home/me/saved.typ"),
    ).toBe("a");
    expect(monacoModelRegistry.getModel("a")).toBe(newEntry);

    // Old model disposed AFTER the swap.
    expect(asMockModel(oldModel).isDisposed).toBe(true);
    // New model NOT disposed.
    expect(asMockModel(newEntry.model).isDisposed).toBe(false);
  });

  it("is a no-op when the new origin produces the SAME uri", () => {
    monacoModelRegistry.openModel("a", openOpts("body", fileOrigin, 0));
    const before = monacoModelRegistry.getModel("a")!;

    // Same path → same uri. No-op.
    const after = monacoModelRegistry.migrateUri("a", fileOrigin);

    expect(after).toBe(before);
    expect(asMockModel(before.model).isDisposed).toBe(false);
    expect(monacoModelRegistry.snapshot()).toHaveLength(1);
  });

  it("throws for an unknown documentId", () => {
    expect(() =>
      monacoModelRegistry.migrateUri("ghost", fileOrigin),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. closeModel
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.closeModel (§10.4)", () => {
  it("disposes the model and removes it from both maps; returns true", () => {
    monacoModelRegistry.openModel("a", openOpts("a", untitledOrigin));
    const model = monacoModelRegistry.getModel("a")!.model;

    const closed = monacoModelRegistry.closeModel("a");

    expect(closed).toBe(true);
    expect(asMockModel(model).isDisposed).toBe(true);
    expect(monacoModelRegistry.getModel("a")).toBeUndefined();
    expect(monacoModelRegistry.resolveDocumentId("untitled:/a.typ")).toBeNull();
  });

  it("returns false for an unknown documentId", () => {
    expect(monacoModelRegistry.closeModel("ghost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. reset
// ---------------------------------------------------------------------------
describe("MonacoModelRegistry.reset", () => {
  it("clears all state", () => {
    monacoModelRegistry.openModel("a", openOpts("a", untitledOrigin));
    monacoModelRegistry.openModel("b", openOpts("b", fileOrigin));
    expect(monacoModelRegistry.snapshot()).toHaveLength(2);

    monacoModelRegistry.resetForTest();

    expect(monacoModelRegistry.snapshot()).toHaveLength(0);
    expect(monacoModelRegistry.getModel("a")).toBeUndefined();
    expect(monacoModelRegistry.resolveDocumentId("untitled:/a.typ")).toBeNull();
  });
});
