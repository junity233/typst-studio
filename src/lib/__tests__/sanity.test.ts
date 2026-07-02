import { describe, it, expect } from "vitest";

describe("vitest jsdom sanity", () => {
  it("provides DOMParser", () => {
    const doc = new DOMParser().parseFromString("<p>hi</p>", "text/html");
    expect(doc.querySelector("p")?.textContent).toBe("hi");
  });
});
