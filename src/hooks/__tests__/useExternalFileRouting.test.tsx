import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenedDocument } from "../../lib/types";
import type { Document } from "../../store/documentsStore";
// React 19 only runs `act`'s effect-flushing + warning behavior when this flag
// is set. We render via react-dom/client directly (no @testing-library/react),
// so opt in here. Mirrors DiffCompareView.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * FIRST tests for `useExternalFileRouting` — single-instance file routing
 * (§6.1): what happens when the user double-clicks a `.typ` file while the app
 * is already running. The backend emits one of two events; the hook's four
 * branches are pinned here:
 *
 *  - `focus_view` + visible tab → plain `activate`;
 *  - `focus_view` + soft-closed (hidden) doc → `reactivate` (mirrors openFile.ts);
 *  - `focus_view` + unknown id → defensive no-op;
 *  - `open_external_file` → `openFileByPath` → `openPath`; `cancelled`
 *    failures stay silent, all others `window.alert` (matches openFile.ts).
 *
 * The hook subscribes through `useTauriListener`; `lib/tauri` is mocked so the
 * two `on*` subscriptions capture their handlers (registration resolves
 * immediately), and the stores under the hook run REAL so the assertions pin
 * store state rather than re-stating the mocks. The factory must cover every
 * named export imported transitively (tabsStore + settingsStore both import
 * `lib/tauri`); a missing one breaks the import.
 */

type Handler = (payload: unknown) => void;
let focusHandler: Handler | null = null;
let openExtHandler: Handler | null = null;

/** A complete `OpenedDocument` payload (backend `open_file_by_path` shape). */
function openedDoc(overrides: Partial<OpenedDocument> = {}): OpenedDocument {
  return {
    id: "doc1",
    title: "x.typ",
    path: "/x.typ",
    dirty: false,
    content: "x",
    origin: { kind: "looseFile", path: "/x.typ", root: "/" },
    revision: 1,
    conflict: "none",
    kind: "typst",
    hidden: false,
    ...overrides,
  };
}

vi.mock("../../lib/tauri", () => ({
  onFocusView: (h: Handler) => {
    focusHandler = h;
    return Promise.resolve(() => {});
  },
  onOpenExternalFile: (h: Handler) => {
    openExtHandler = h;
    return Promise.resolve(() => {});
  },
  openFileByPath: vi.fn(),
  // tabsStore imports these (reactivate / openPath paths):
  reactivateTab: vi.fn(() => Promise.resolve(openedDoc())),
  softCloseTab: vi.fn(() => Promise.resolve()),
  hardCloseTab: vi.fn(() => Promise.resolve()),
  newTab: vi.fn(() => Promise.resolve(openedDoc())),
  updateText: vi.fn(() => Promise.resolve()),
  // settingsStore (via useSetting) imports these:
  getAllSettings: vi.fn(() => Promise.resolve({})),
  getSettingsManifest: vi.fn(() => Promise.resolve(null)),
  onSettingsChanged: vi.fn(() => Promise.resolve(() => {})),
  setSetting: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/session", () => ({
  captureAndSaveSession: vi.fn(() => Promise.resolve()),
  recordFile: vi.fn(),
}));

// Imported dynamically so the vi.mock factories above run AFTER the `let`
// handler declarations (a static import would hoist before them → TDZ).
// Mirrors the await-import pattern of useTypstCompile.conflict.test.ts.
const { useExternalFileRouting } = await import("../useExternalFileRouting");
const { useTabsStore } = await import("../../store/tabsStore");
const { useDocumentsStore } = await import("../../store/documentsStore");
const { openFileByPath, reactivateTab } = await import("../../lib/tauri");

/** Build a minimal live `Document` for seeding the documents map. */
function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc1",
    title: "x.typ",
    path: "/x.typ",
    dirty: false,
    content: "x",
    origin: { kind: "looseFile", path: "/x.typ", root: "/" },
    revision: 1,
    compiledRevision: 1,
    conflict: "none",
    conflictDiskContent: null,
    status: "idle",
    durationMs: null,
    svgPages: [],
    lineMap: [],
    outline: [],
    ...overrides,
  };
}

function Routing() {
  useExternalFileRouting();
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Macrotask boundary — flushes every pending microtask chain once. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Emit a `focus_view` event and let the (possibly async) handler settle. */
async function emitFocus(id: string): Promise<void> {
  expect(focusHandler).not.toBeNull();
  await act(async () => {
    focusHandler!({ id });
    await flush();
  });
}

/** Emit an `open_external_file` event and let the async handler settle. */
async function emitOpenExternal(path: string): Promise<void> {
  expect(openExtHandler).not.toBeNull();
  await act(async () => {
    await openExtHandler!({ path });
    await flush();
  });
}

function resetStores(): void {
  useTabsStore.setState({ tabs: [], hidden: [], activeId: null });
  useDocumentsStore.setState({ documents: {} });
}

let alertSpy: ReturnType<typeof vi.spyOn>;

describe("useExternalFileRouting (single-instance file routing)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetStores();
    focusHandler = null;
    openExtHandler = null;
    // jsdom's window.alert logs "Not implemented" — stub it; several branches
    // assert on its (non-)invocation.
    alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Routing />);
    });
    // Let both subscribe promises resolve (handlers are captured during the
    // effect, synchronously; the unlisten resolution needs a flush).
    await act(async () => {
      await flush();
    });
    expect(focusHandler).not.toBeNull();
    expect(openExtHandler).not.toBeNull();
  });

  afterEach(() => {
    if (root !== null && container !== null) {
      const r = root;
      act(() => {
        r.unmount();
      });
      container.remove();
    }
    root = null;
    container = null;
    vi.restoreAllMocks();
    resetStores();
  });

  it("focus_view on a visible tab activates it (no reactivate round-trip)", async () => {
    useTabsStore.setState({ tabs: ["doc1", "doc2"], hidden: [], activeId: "doc2" });
    useDocumentsStore.setState({
      documents: { doc1: doc({ id: "doc1" }), doc2: doc({ id: "doc2" }) },
    });

    await emitFocus("doc1");

    expect(useTabsStore.getState().activeId).toBe("doc1");
    expect(reactivateTab).not.toHaveBeenCalled();
  });

  it("focus_view on a soft-closed (hidden) doc reactivates it", async () => {
    useTabsStore.setState({ tabs: ["other"], hidden: ["doc1"], activeId: "other" });
    useDocumentsStore.setState({
      documents: { doc1: doc({ id: "doc1" }), other: doc({ id: "other" }) },
    });

    await emitFocus("doc1");

    expect(reactivateTab).toHaveBeenCalledWith("doc1");
    const s = useTabsStore.getState();
    expect(s.hidden).not.toContain("doc1");
    expect(s.tabs).toContain("doc1");
    expect(s.activeId).toBe("doc1");
  });

  it("focus_view on an unknown id is a safe no-op (defensive branch)", async () => {
    useTabsStore.setState({ tabs: ["doc1"], hidden: [], activeId: "doc1" });
    useDocumentsStore.setState({ documents: { doc1: doc({ id: "doc1" }) } });

    await expect(emitFocus("ghost-id")).resolves.toBeUndefined();

    const s = useTabsStore.getState();
    expect(s.tabs).toEqual(["doc1"]);
    expect(s.activeId).toBe("doc1"); // unchanged
    expect(reactivateTab).not.toHaveBeenCalled();
  });

  it("open_external_file opens the file: openFileByPath → openPath (real store state)", async () => {
    vi.mocked(openFileByPath).mockResolvedValue(
      openedDoc({ id: "opened1", path: "/x/a.typ", title: "a.typ" }),
    );

    await emitOpenExternal("/x/a.typ");

    expect(openFileByPath).toHaveBeenCalledWith("/x/a.typ");
    const s = useTabsStore.getState();
    expect(s.tabs).toContain("opened1");
    expect(s.activeId).toBe("opened1");
    // The real documentsStore got the domain entry via openPath →
    // documentFromOpened (asserted on the store, not the mock).
    const opened = useDocumentsStore.getState().documents["opened1"];
    expect(opened).toBeDefined();
    expect(opened?.title).toBe("a.typ");
  });

  it("open_external_file failure with code 'cancelled' stays silent (no alert)", async () => {
    vi.mocked(openFileByPath).mockRejectedValue({
      code: "cancelled",
      message: "user cancelled",
      recoverable: true,
    });

    await emitOpenExternal("/x/locked.typ");

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("open_external_file failure with another code alerts with the error message", async () => {
    vi.mocked(openFileByPath).mockRejectedValue({
      code: "permission_denied",
      message: "access denied to /x/locked.typ",
      recoverable: true,
    });

    await emitOpenExternal("/x/locked.typ");

    expect(alertSpy).toHaveBeenCalledTimes(1);
    // en locale: "Could not open: {{message}}" — pin the branch + the message
    // text making it into the alert, not the exact surrounding phrasing.
    expect(String(alertSpy.mock.calls[0][0])).toContain(
      "access denied to /x/locked.typ",
    );
  });
});
