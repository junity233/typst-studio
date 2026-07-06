import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../assistantPrompt";

describe("buildSystemPrompt", () => {
  it("injects workspace name and active file path", () => {
    const p = buildSystemPrompt({
      workspaceName: "my-project",
      activeFilePath: "/ws/main.typ",
      uiLanguage: "en",
    });
    expect(p).toContain("Workspace: my-project");
    expect(p).toContain("Active file: /ws/main.typ");
  });

  it("handles null workspace and active file", () => {
    const p = buildSystemPrompt({
      workspaceName: null,
      activeFilePath: null,
      uiLanguage: "zh",
    });
    expect(p).toContain("no workspace open");
    expect(p).toContain("Active file: none");
    expect(p).toContain('"zh"');
  });

  it("includes the reply-language instruction", () => {
    const p = buildSystemPrompt({
      workspaceName: null,
      activeFilePath: null,
      uiLanguage: "en",
    });
    expect(p.toLowerCase()).toContain("reply in the app ui language");
  });

  it("documents the edit tool's uniqueness constraint", () => {
    const p = buildSystemPrompt({
      workspaceName: null,
      activeFilePath: null,
      uiLanguage: "en",
    });
    expect(p.toLowerCase()).toContain("unique");
    expect(p.toLowerCase()).toContain("byte-for-byte");
  });
});
