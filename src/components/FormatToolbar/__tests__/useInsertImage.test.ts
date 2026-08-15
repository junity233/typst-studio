import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Format Toolbar Task 6 — insert-image hook tests.
 *
 * `useInsertImage` is a thin orchestrator: it stitches together
 * pickImageFile → readFileBytes → inferExt → resolveImageDir → expandTemplate →
 * ensureAbsolute → writeImage → imageSrcForInsert → replaceSelection. The path
 * math itself lives in those primitives (each tested independently), so here we
 * only pin the orchestration: the right calls happen in order, cancel is a
 * clean no-op, and the inserted `#image("…")` string carries the escaped source
 * path (document-relative when expressible, absolute otherwise).
 *
 * Every primitive is mocked via `vi.mock` so the test never touches Tauri IPC
 * or the real filesystem. The factories are hoisted above the imports
 * (vitest's standard behavior), and each returns vi.fn() spies the assertions
 * read after running the callback.
 */

const pickImageFile = vi.fn();
const readFileBytes = vi.fn();
const inferExt = vi.fn();
const resolveImageDir = vi.fn();
const expandTemplate = vi.fn();
const ensureAbsolute = vi.fn();
const writeImage = vi.fn();
const imageSrcForInsert = vi.fn();

vi.mock("../../../lib/tauri", () => ({ pickImageFile, readFileBytes }));
vi.mock("../../../lib/htmlToTypst/images", () => ({ inferExt }));
// escapeTypstStr is the REAL implementation — its behavior is pinned by its
// own unit tests; here we want to assert the inserted string is escaped, so
// mocking it would defeat the purpose.
vi.mock("../../../components/Editor/imageIo", () => ({
  resolveImageDir,
  ensureAbsolute,
  writeImage,
  imageSrcForInsert,
}));
vi.mock("../../../lib/pathMacros", () => ({ expandTemplate }));

const { useInsertImage } = await import("../useInsertImage");
import type { FormatApi } from "../formatActions";
import type { Tab } from "../../../store/tabsStore";

const makeMockApi = (): FormatApi & {
  replace: ReturnType<typeof vi.fn>;
} => {
  const replace = vi.fn();
  return {
    wrapSelection: vi.fn(),
    replaceSelection: replace,
    toggleLinePrefix: vi.fn(),
    getSelectionText: vi.fn(() => ""),
    // State-aware seam (T2): present to satisfy FormatApi; the image flow never
    // touches them, so they default to inactive returns.
    toggleWrap: vi.fn(),
    isInsideWrap: vi.fn().mockReturnValue(false),
    isLinePrefixActive: vi.fn().mockReturnValue(false),
    onDidChangeCursorPosition: vi.fn().mockReturnValue(() => {}),
    replace,
  };
};

const TAB = { id: "doc-1", path: "/docs/main.typ" } as unknown as Tab;

const runFlow = async (over: Partial<Parameters<typeof useInsertImage>[0]> = {}) => {
  const api = makeMockApi();
  const insertImage = useInsertImage({
    tab: TAB,
    workspace: "/ws",
    insertImagePathTemplate: "${fileDir}/assets/${fileName}",
    ...over,
  });
  await insertImage(api);
  return api;
};

describe("useInsertImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when the picker is cancelled (returns null)", async () => {
    pickImageFile.mockResolvedValue(null);
    const api = await runFlow();
    expect(readFileBytes).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
    expect(api.replace).not.toHaveBeenCalled();
  });

  it("no-ops when there is no tab", async () => {
    pickImageFile.mockResolvedValue("/x/pic.png");
    const api = await runFlow({ tab: null });
    expect(pickImageFile).not.toHaveBeenCalled();
    expect(api.replace).not.toHaveBeenCalled();
  });

  it("happy path: writes the file and inserts #image(\"…\") with the relative src", async () => {
    pickImageFile.mockResolvedValue("/photos/cat.png");
    readFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/docs");
    expandTemplate.mockReturnValue("/docs/assets/cat.png");
    ensureAbsolute.mockResolvedValue("/docs/assets/cat.png");
    writeImage.mockResolvedValue(undefined);
    imageSrcForInsert.mockResolvedValue("assets/cat.png");

    const api = await runFlow();

    // Bytes forwarded to writeImage unchanged.
    expect(writeImage).toHaveBeenCalledWith(
      "/docs/assets/cat.png",
      new Uint8Array([1, 2, 3]),
    );
    // imageSrcForInsert derives the insert source from the absolute written
    // path plus the tab/context (mirrors both paste pipelines).
    expect(imageSrcForInsert).toHaveBeenCalledWith(
      "/docs/assets/cat.png",
      TAB,
      expect.objectContaining({ workspace: "/ws", filePath: "/docs/main.typ" }),
    );
    // Inserted text is the relative source inside #image("…").
    expect(api.replace).toHaveBeenCalledTimes(1);
    expect(api.replace).toHaveBeenCalledWith('#image("assets/cat.png")');
  });

  it("derives fileName from the picked path basename", async () => {
    pickImageFile.mockResolvedValue("C:\\photos\\dog.jpeg");
    readFileBytes.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("jpg");
    resolveImageDir.mockResolvedValue("/docs");
    expandTemplate.mockReturnValue("expanded");
    ensureAbsolute.mockResolvedValue("/abs/expanded");
    writeImage.mockResolvedValue(undefined);
    imageSrcForInsert.mockResolvedValue("/abs/expanded");

    await runFlow({ insertImagePathTemplate: undefined });

    // expandTemplate receives fileName derived from the basename (Windows
    // backslash path → "dog.jpeg"), and the default template kicks in since
    // the setting is undefined.
    expect(expandTemplate).toHaveBeenCalledWith(
      "${fileDir}/assets/${fileName}",
      expect.objectContaining({ fileName: "dog.jpeg" }),
    );
  });

  it("passes the template through when the setting is set", async () => {
    pickImageFile.mockResolvedValue("/x/a.png");
    readFileBytes.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("r");
    ensureAbsolute.mockResolvedValue("/abs/r");
    writeImage.mockResolvedValue(undefined);
    imageSrcForInsert.mockResolvedValue("r");

    await runFlow({ insertImagePathTemplate: "${fileDir}/img.${ext}" });

    expect(expandTemplate).toHaveBeenCalledWith(
      "${fileDir}/img.${ext}",
      expect.any(Object),
    );
  });

  it("escapes backslashes and quotes in the inserted path", async () => {
    pickImageFile.mockResolvedValue("/x/a.png");
    readFileBytes.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue(undefined);
    // A path containing both a backslash and a double-quote character.
    ensureAbsolute.mockResolvedValue('C:\\docs\\my "weird".png');
    writeImage.mockResolvedValue(undefined);
    expandTemplate.mockReturnValue('C:\\docs\\my "weird".png');
    // imageSrcForInsert can't express a relative path here (cross-drive
    // fallback), so the insert carries the absolute path — which must still
    // be escaped.
    imageSrcForInsert.mockResolvedValue('C:\\docs\\my "weird".png');

    const api = await runFlow();

    // escapeTypstStr: `\` → `\\`, `"` → `\"`. So `C:\docs\my "weird".png`
    // becomes `C:\\docs\\my \"weird\".png` inside the #image("…") literal.
    expect(api.replace).toHaveBeenCalledWith(
      '#image("C:\\\\docs\\\\my \\"weird\\".png")',
    );
  });

  it("runs the primitives in the documented order", async () => {
    pickImageFile.mockResolvedValue("/x/a.png");
    readFileBytes.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("r");
    ensureAbsolute.mockResolvedValue("/abs/r");
    writeImage.mockResolvedValue(undefined);
    imageSrcForInsert.mockResolvedValue("r");

    await runFlow();

    // Order: pick → read → inferExt → resolveDir → expand → ensureAbsolute →
    // writeImage → imageSrcForInsert → replaceSelection. We assert relative
    // order via call index.
    const order = [
      pickImageFile,
      readFileBytes,
      inferExt,
      resolveImageDir,
      expandTemplate,
      ensureAbsolute,
      writeImage,
      imageSrcForInsert,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i].mock.invocationCallOrder[0],
        `${order[i].name} should be called after ${order[i - 1].name}`,
      ).toBeGreaterThan(order[i - 1].mock.invocationCallOrder[0]);
    }
  });

  it("writes the absolute path but inserts the relative src (roles stay split)", async () => {
    // The disk write must always receive the absolute path (where the bytes
    // actually live), while the inserted #image() reference uses the relative
    // source derived by imageSrcForInsert — the two responsibilities must not
    // get conflated when the src differs from the written path.
    pickImageFile.mockResolvedValue("/photos/cat.png");
    readFileBytes.mockResolvedValue(new Uint8Array([7]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/docs");
    expandTemplate.mockReturnValue("/docs/assets/cat.png");
    ensureAbsolute.mockResolvedValue("/docs/assets/cat.png");
    writeImage.mockResolvedValue(undefined);
    imageSrcForInsert.mockResolvedValue("assets/cat.png");

    const api = await runFlow();

    expect(writeImage).toHaveBeenCalledWith("/docs/assets/cat.png", new Uint8Array([7]));
    expect(api.replace).toHaveBeenCalledWith('#image("assets/cat.png")');
  });

  it("catches an imageSrcForInsert rejection (no throw, no editor insert) and logs", async () => {
    // The src-derivation step is awaited after writeImage; if it rejects
    // (e.g. path math throws), the shared catch must swallow it so the
    // `void`-style caller never sees an unhandled rejection — and the flow
    // must abort before the editor insert.
    pickImageFile.mockResolvedValue("/x/a.png");
    readFileBytes.mockResolvedValue(new Uint8Array([1]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("/x/assets/a.png");
    ensureAbsolute.mockResolvedValue("/x/assets/a.png");
    writeImage.mockResolvedValue(undefined);
    imageSrcForInsert.mockRejectedValue(new Error("path math failed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const api = await runFlow();

    expect(writeImage).toHaveBeenCalledTimes(1); // the file was written
    expect(api.replace).not.toHaveBeenCalled(); // flow aborted before insert
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toBe(
      "[FormatToolbar] insert image failed:",
    );
    errSpy.mockRestore();
  });

  it("catches a writeImage rejection (no throw, no editor insert) and logs", async () => {
    // The flow must not let a writeImage failure (disk full, permissions)
    // bubble as an unhandled rejection. The catch logs clearly and aborts
    // before the editor insert.
    pickImageFile.mockResolvedValue("/x/a.png");
    readFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("/x/assets/a.png");
    ensureAbsolute.mockResolvedValue("/x/assets/a.png");
    writeImage.mockRejectedValue(new Error("disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should NOT throw — the callback swallows the rejection.
    const api = await runFlow();

    expect(writeImage).toHaveBeenCalledTimes(1); // the failing call happened
    expect(imageSrcForInsert).not.toHaveBeenCalled(); // abort happens before insert
    expect(api.replace).not.toHaveBeenCalled(); // flow aborted before insert
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toBe(
      "[FormatToolbar] insert image failed:",
    );
    errSpy.mockRestore();
  });
});
