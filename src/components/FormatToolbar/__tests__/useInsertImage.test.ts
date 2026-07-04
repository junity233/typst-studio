import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Format Toolbar Task 6 — insert-image hook tests.
 *
 * `useInsertImage` is a thin orchestrator: it stitches together
 * pickImageFile → readFile → inferExt → resolveImageDir → expandTemplate →
 * ensureAbsolute → writeImage → replaceSelection. The path math itself lives
 * in those primitives (each tested independently), so here we only pin the
 * orchestration: the right calls happen in order, cancel is a clean no-op,
 * and the inserted `#image("…")` string carries the escaped absolute path.
 *
 * Every primitive is mocked via `vi.mock` so the test never touches Tauri IPC
 * or the real filesystem. The factories are hoisted above the imports
 * (vitest's standard behavior), and each returns vi.fn() spies the assertions
 * read after running the callback.
 */

const pickImageFile = vi.fn();
const readFile = vi.fn();
const inferExt = vi.fn();
const resolveImageDir = vi.fn();
const expandTemplate = vi.fn();
const ensureAbsolute = vi.fn();
const writeImage = vi.fn();

vi.mock("../../../lib/tauri", () => ({ pickImageFile }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile }));
vi.mock("../../../lib/htmlToTypst/images", () => ({ inferExt }));
// escapeTypstStr is the REAL implementation — its behavior is pinned by its
// own unit tests; here we want to assert the inserted string is escaped, so
// mocking it would defeat the purpose.
vi.mock("../../../components/Editor/imageIo", () => ({
  resolveImageDir,
  ensureAbsolute,
  writeImage,
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
    expect(readFile).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
    expect(api.replace).not.toHaveBeenCalled();
  });

  it("no-ops when there is no tab", async () => {
    pickImageFile.mockResolvedValue("/x/pic.png");
    const api = await runFlow({ tab: null });
    expect(pickImageFile).not.toHaveBeenCalled();
    expect(api.replace).not.toHaveBeenCalled();
  });

  it("happy path: writes the file and inserts #image(\"…\") with the absolute path", async () => {
    pickImageFile.mockResolvedValue("/photos/cat.png");
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/docs");
    expandTemplate.mockReturnValue("/docs/assets/cat.png");
    ensureAbsolute.mockResolvedValue("/docs/assets/cat.png");
    writeImage.mockResolvedValue(undefined);

    const api = await runFlow();

    // Bytes forwarded to writeImage unchanged.
    expect(writeImage).toHaveBeenCalledWith(
      "/docs/assets/cat.png",
      new Uint8Array([1, 2, 3]),
    );
    // Inserted text is the absolute path inside #image("…").
    expect(api.replace).toHaveBeenCalledTimes(1);
    expect(api.replace).toHaveBeenCalledWith('#image("/docs/assets/cat.png")');
  });

  it("derives fileName from the picked path basename", async () => {
    pickImageFile.mockResolvedValue("C:\\photos\\dog.jpeg");
    readFile.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("jpg");
    resolveImageDir.mockResolvedValue("/docs");
    expandTemplate.mockReturnValue("expanded");
    ensureAbsolute.mockResolvedValue("/abs/expanded");
    writeImage.mockResolvedValue(undefined);

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
    readFile.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("r");
    ensureAbsolute.mockResolvedValue("/abs/r");
    writeImage.mockResolvedValue(undefined);

    await runFlow({ insertImagePathTemplate: "${fileDir}/img.${ext}" });

    expect(expandTemplate).toHaveBeenCalledWith(
      "${fileDir}/img.${ext}",
      expect.any(Object),
    );
  });

  it("escapes backslashes and quotes in the inserted path", async () => {
    pickImageFile.mockResolvedValue("/x/a.png");
    readFile.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue(undefined);
    // A path containing both a backslash and a double-quote character.
    ensureAbsolute.mockResolvedValue('C:\\docs\\my "weird".png');
    writeImage.mockResolvedValue(undefined);
    expandTemplate.mockReturnValue('C:\\docs\\my "weird".png');

    const api = await runFlow();

    // escapeTypstStr: `\` → `\\`, `"` → `\"`. So `C:\docs\my "weird".png`
    // becomes `C:\\docs\\my \"weird\".png` inside the #image("…") literal.
    expect(api.replace).toHaveBeenCalledWith(
      '#image("C:\\\\docs\\\\my \\"weird\\".png")',
    );
  });

  it("runs the primitives in the documented order", async () => {
    pickImageFile.mockResolvedValue("/x/a.png");
    readFile.mockResolvedValue(new Uint8Array([]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("r");
    ensureAbsolute.mockResolvedValue("/abs/r");
    writeImage.mockResolvedValue(undefined);

    await runFlow();

    // Order: pick → read → inferExt → resolveDir → expand → ensureAbsolute →
    // writeImage → replaceSelection. We assert relative order via call index.
    const order = [
      pickImageFile,
      readFile,
      inferExt,
      resolveImageDir,
      expandTemplate,
      ensureAbsolute,
      writeImage,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i].mock.invocationCallOrder[0],
        `${order[i].name} should be called after ${order[i - 1].name}`,
      ).toBeGreaterThan(order[i - 1].mock.invocationCallOrder[0]);
    }
  });

  it("catches a writeImage rejection (no throw, no editor insert) and logs", async () => {
    // The flow must not let a writeImage failure (disk full, permissions)
    // bubble as an unhandled rejection. The catch logs clearly and aborts
    // before the editor insert.
    pickImageFile.mockResolvedValue("/x/a.png");
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    inferExt.mockReturnValue("png");
    resolveImageDir.mockResolvedValue("/x");
    expandTemplate.mockReturnValue("/x/assets/a.png");
    ensureAbsolute.mockResolvedValue("/x/assets/a.png");
    writeImage.mockRejectedValue(new Error("disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should NOT throw — the callback swallows the rejection.
    const api = await runFlow();

    expect(writeImage).toHaveBeenCalledTimes(1); // the failing call happened
    expect(api.replace).not.toHaveBeenCalled(); // flow aborted before insert
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toBe(
      "[FormatToolbar] insert image failed:",
    );
    errSpy.mockRestore();
  });
});
