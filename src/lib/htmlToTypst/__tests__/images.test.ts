import { describe, it, expect } from "vitest";
import { inferExt, collectImage } from "../images";
import { makeWalkCtx } from "../types";

describe("inferExt", () => {
  it("png from data uri", () => {
    expect(inferExt("data:image/png;base64,iVBOR")).toBe("png");
  });
  it("jpeg -> jpg", () => {
    expect(inferExt("data:image/jpeg;base64,/9j/")).toBe("jpg");
  });
  it("svg+xml -> svg", () => {
    expect(inferExt("data:image/svg+xml;base64,PHN2Zz4=")).toBe("svg");
  });
  it("from url extension", () => {
    expect(inferExt("https://a.b/img/photo.PNG")).toBe("png");
  });
  it("defaults to png when none", () => {
    expect(inferExt("https://a.b/photo")).toBe("png");
  });
});

describe("collectImage", () => {
  it("registers pending image and returns placeholder", () => {
    const wctx = makeWalkCtx({
      imageTemplate: "${fileDir}/a-${hash}.${ext}",
      fetchRemote: true,
    });
    const img = document.createElement("img");
    img.setAttribute("src", "data:image/png;base64,iVBOR");
    img.setAttribute("alt", "diagram");
    const ph = collectImage(img, wctx);
    expect(ph).toMatch(/^\u0000IMG0\u0000$/);
    expect(wctx.pendingImages).toHaveLength(1);
    expect(wctx.pendingImages[0]).toEqual({
      placeholder: ph,
      src: "data:image/png;base64,iVBOR",
      alt: "diagram",
      index: 0,
    });
    expect(wctx.nextImageIndex).toBe(1);
  });
});
