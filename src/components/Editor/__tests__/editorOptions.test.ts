import { describe, expect, it } from "vitest";
import { shouldDisableOccurrencesHighlight } from "../editorOptions";

describe("shouldDisableOccurrencesHighlight", () => {
  it("disables occurrence highlighting for every current Typst document origin", () => {
    expect(shouldDisableOccurrencesHighlight("untitled")).toBe(true);
    expect(shouldDisableOccurrencesHighlight("looseFile")).toBe(true);
    expect(shouldDisableOccurrencesHighlight("workspaceFile")).toBe(true);
  });
});
