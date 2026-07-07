import { describe, expect, it, vi } from "vitest";

/**
 * Mock the opener plugin so `openExternalUrl` doesn't reach the Tauri bridge.
 * Import the SUT AFTER registering the mock.
 */
const openUrlMock = vi.fn<(url: string | URL) => Promise<void>>();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string | URL) => openUrlMock(url),
}));

const { isExternalHref, openExternalUrl } = await import("../openLink");

describe("isExternalHref", () => {
  it.each([
    "http://example.com",
    "https://example.com/path?q=1",
    "mailto:foo@bar.com",
    "tel:+15551234567",
    "HTTP://CASE-INSENSITIVE.example",
  ])("treats %s as external", (href) => {
    expect(isExternalHref(href)).toBe(true);
  });

  it.each([
    "#anchor",
    "./relative",
    "/absolute/path",
    "javascript:alert(1)",
    "ftp://example.com",
    "",
    undefined,
  ])("treats %p as NOT external", (href) => {
    expect(isExternalHref(href)).toBe(false);
  });
});

describe("openExternalUrl", () => {
  it("calls openUrl with the given url", async () => {
    openUrlMock.mockResolvedValueOnce(undefined);
    await openExternalUrl("https://example.com");
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });

  it("swallows plugin errors instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    openUrlMock.mockRejectedValueOnce(new Error("disallowed"));
    await expect(openExternalUrl("ftp://nope")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
