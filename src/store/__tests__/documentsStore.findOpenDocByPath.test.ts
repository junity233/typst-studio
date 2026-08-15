import { beforeEach, describe, expect, it } from "vitest";
import { findOpenDocByPath, useDocumentsStore } from "../documentsStore";
import type { Document } from "../documentsStore";

function doc(id: string, path: string | null): Document {
  return {
    id,
    title: id,
    path,
    dirty: false,
    content: "",
    revision: 0,
    kind: "typst",
    origin: { kind: "untitled" },
    status: "idle",
    svgPages: [],
    pageCount: 0,
    compiledRevision: -1,
    conflict: null,
    outline: [],
    lastChangedPages: null,
  } as unknown as Document;
}

describe("findOpenDocByPath", () => {
  beforeEach(() => {
    useDocumentsStore.setState({ documents: {} });
  });

  it("finds the doc whose canonical path matches (separator- and case-insensitive on Windows)", () => {
    useDocumentsStore.setState({
      documents: {
        a: doc("a", "C:\\code\\ws\\main.typ"),
        b: doc("b", "/home/user/notes.md"),
        c: doc("c", null),
      },
    });
    expect(findOpenDocByPath("C:/code/ws/main.typ")?.id).toBe("a");
    expect(findOpenDocByPath("c:\\CODE\\ws\\main.typ")?.id).toBe("a");
  });

  it("is case-sensitive on POSIX paths and skips null-path docs", () => {
    useDocumentsStore.setState({
      documents: {
        b: doc("b", "/home/user/notes.md"),
        c: doc("c", null),
      },
    });
    expect(findOpenDocByPath("/home/user/notes.md")?.id).toBe("b");
    expect(findOpenDocByPath("/home/user/Notes.md")).toBeUndefined();
    expect(findOpenDocByPath("/nowhere.typ")).toBeUndefined();
  });
});
