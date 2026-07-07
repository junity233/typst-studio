import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  openDialog: vi.fn(),
  join: vi.fn(),
  packageCompilerVersion: vi.fn(),
  packageDirIsEmpty: vi.fn(),
  packageImportSnippet: vi.fn(),
  packageInitTemplate: vi.fn(),
  openWorkspaceByPath: vi.fn(),
  openFile: vi.fn(),
  confirm: vi.fn(),
  hydrate: vi.fn(),
  setActiveView: vi.fn(),
  setSelected: vi.fn(),
  install: vi.fn(),
  packagesState: {
    selectedKey: "thesis@1.0.0",
    index: [
      {
        name: "thesis",
        version: "1.0.0",
        description: "A thesis template",
        categories: ["paper"],
        compiler: null,
        license: null,
        template: {
          path: "template",
          entrypoint: "paper/main.typ",
          thumbnail: null,
        },
      },
    ],
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openDialog,
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: mocks.join,
}));

vi.mock("../../../../store/packagesStore", () => ({
  usePackagesStore: (selector: (state: unknown) => unknown) =>
    selector({
      ...mocks.packagesState,
      setSelected: mocks.setSelected,
      install: mocks.install,
    }),
}));

vi.mock("../../../../store/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      hydrate: mocks.hydrate,
    }),
}));

vi.mock("../../../../store/uiStore", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      setActiveView: mocks.setActiveView,
    }),
}));

vi.mock("../../../../lib/openFile", () => ({
  openFile: mocks.openFile,
}));

vi.mock("../../../../lib/tauri", () => ({
  packageCompilerVersion: mocks.packageCompilerVersion,
  packageDirIsEmpty: mocks.packageDirIsEmpty,
  packageImportSnippet: mocks.packageImportSnippet,
  packageInitTemplate: mocks.packageInitTemplate,
  openWorkspaceByPath: mocks.openWorkspaceByPath,
}));

vi.mock("../Thumbnail", () => ({
  Thumbnail: () => null,
}));

vi.mock("../PackageReadme", () => ({
  PackageReadme: () => null,
}));

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { PackageDetail } from "../PackageDetail";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.openDialog.mockResolvedValue("D:\\tmp\\from-template");
  mocks.join.mockImplementation(async (base: string, rel: string) =>
    `${base}\\${rel.replace(/\//g, "\\")}`,
  );
  mocks.packageCompilerVersion.mockResolvedValue("0.15.0");
  mocks.packageDirIsEmpty.mockResolvedValue(true);
  mocks.packageImportSnippet.mockReturnValue('#import "@preview/thesis:1.0.0": *');
  mocks.packageInitTemplate.mockResolvedValue("paper/main.typ");
  mocks.openWorkspaceByPath.mockResolvedValue({
    root: "D:\\tmp\\from-template",
    name: "from-template",
  });
  mocks.hydrate.mockResolvedValue(undefined);
  mocks.openFile.mockResolvedValue("doc-1");
  vi.stubGlobal("confirm", mocks.confirm);
  mocks.confirm.mockReturnValue(true);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PackageDetail />);
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function clickUseTemplate() {
  const button = Array.from(container.querySelectorAll("button")).find(
    (el) => el.textContent === "useTemplate",
  );
  expect(button).toBeDefined();

  await act(async () => {
    button!.click();
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("PackageDetail template flow", () => {
  it("opens the initialized template entry file in the frontend tab flow", async () => {
    await clickUseTemplate();

    expect(mocks.packageDirIsEmpty).toHaveBeenCalledWith("D:\\tmp\\from-template");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.packageInitTemplate).toHaveBeenCalledWith(
      "thesis",
      "1.0.0",
      "D:\\tmp\\from-template",
      false,
    );
    expect(mocks.openWorkspaceByPath).toHaveBeenCalledWith("D:\\tmp\\from-template");
    expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    expect(mocks.join).toHaveBeenCalledWith(
      "D:\\tmp\\from-template",
      "paper/main.typ",
    );
    expect(mocks.openFile).toHaveBeenCalledWith(
      "D:\\tmp\\from-template\\paper\\main.typ",
    );
    expect(mocks.setActiveView).toHaveBeenCalledWith("workbench.explorer");
  });

  it("asks before applying a template into a non-empty folder and then overwrites", async () => {
    mocks.packageDirIsEmpty.mockResolvedValue(false);

    await clickUseTemplate();

    expect(mocks.confirm).toHaveBeenCalledWith("confirmOverwrite");
    expect(mocks.packageInitTemplate).toHaveBeenCalledWith(
      "thesis",
      "1.0.0",
      "D:\\tmp\\from-template",
      true,
    );
    expect(mocks.openFile).toHaveBeenCalledWith(
      "D:\\tmp\\from-template\\paper\\main.typ",
    );
  });
});
