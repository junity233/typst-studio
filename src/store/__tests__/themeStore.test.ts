import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * themeStore `applyTheme` tests — the first coverage for this module.
 *
 * `applyTheme` owns the DOM side effect of theming: a single `<style
 * id="user-theme">` element that is created, reused, or removed. The unit's
 * most interesting logic is its request-token race guard (only the latest
 * call's fetch result may touch the DOM) and its fallback semantics
 * (`null` CSS → default). The tauri IPC layer is mocked so no Tauri runtime
 * is needed; the DOM is jsdom.
 *
 * The module-scoped `applyToken` counter is never reset between tests, which
 * is fine: it only needs to distinguish concurrent in-flight calls, and each
 * test resolves every promise it starts.
 */

const getThemeCss = vi.fn();
const listThemes = vi.fn();
const onThemesChanged = vi.fn();

vi.mock("../../lib/tauri", () => ({ getThemeCss, listThemes, onThemesChanged }));

const { applyTheme } = await import("../themeStore");

const getStyle = () => document.getElementById("user-theme");

/** Minimal deferred so tests can resolve `getThemeCss` at a chosen moment. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("applyTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStyle()?.remove();
  });

  it("treats undefined and empty ids as default: no IPC, element removed", async () => {
    const stale = document.createElement("style");
    stale.id = "user-theme";
    document.head.appendChild(stale);

    await applyTheme(undefined);
    await applyTheme("");

    expect(getThemeCss).not.toHaveBeenCalled();
    expect(getStyle()).toBeNull();
  });

  it("injects a single #user-theme style with the fetched CSS at the end of <head>", async () => {
    getThemeCss.mockResolvedValue("/* css-a */");

    await applyTheme("a");

    const style = getStyle();
    expect(style).not.toBeNull();
    expect(style?.tagName).toBe("STYLE");
    expect(style?.textContent).toBe("/* css-a */");
    expect(document.head.lastElementChild).toBe(style);
  });

  it("reuses the existing element when re-applying (no duplicates)", async () => {
    getThemeCss.mockResolvedValueOnce("/* css-a */").mockResolvedValueOnce("/* css-b */");

    await applyTheme("a");
    await applyTheme("b");

    const styles = document.head.querySelectorAll("#user-theme");
    expect(styles.length).toBe(1);
    expect(styles[0]?.textContent).toBe("/* css-b */");
  });

  it("removes the element when the backend reports an unknown theme (null)", async () => {
    const stale = document.createElement("style");
    stale.id = "user-theme";
    document.head.appendChild(stale);
    getThemeCss.mockResolvedValue(null);

    await applyTheme("deleted-theme");

    expect(getStyle()).toBeNull();
  });

  it("race: a switch to default while a fetch is in flight wins", async () => {
    const first = deferred<string | null>();
    getThemeCss.mockReturnValueOnce(first.promise);

    const pending = applyTheme("a");
    // While "a" is still loading, the user switches to default (completes
    // synchronously and removes any element).
    await applyTheme(undefined);
    expect(getStyle()).toBeNull();

    // The stale "a" result resolves last and must be discarded by the token
    // guard — it must NOT re-add the element.
    first.resolve("/* css-a */");
    await pending;
    expect(getStyle()).toBeNull();
  });

  it("race: an earlier in-flight fetch cannot overwrite a later theme", async () => {
    const a = deferred<string | null>();
    getThemeCss.mockReturnValueOnce(a.promise).mockResolvedValueOnce("/* css-b */");

    const pendingA = applyTheme("a");
    await applyTheme("b"); // resolves immediately while "a" is still in flight
    expect(getStyle()?.textContent).toBe("/* css-b */");

    a.resolve("/* css-a */");
    await pendingA;
    expect(getStyle()?.textContent).toBe("/* css-b */");
  });

  it("regression: a rejected getThemeCss resolves undefined, falls back to default, and warns", async () => {
    const stale = document.createElement("style");
    stale.id = "user-theme";
    document.head.appendChild(stale);
    getThemeCss.mockRejectedValue(new Error("ipc down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The caller (useTheme) fires `void applyTheme(...)` — this must not
    // become an unhandled rejection.
    await expect(applyTheme("a")).resolves.toBeUndefined();

    expect(getStyle()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("falling back to default");
    warnSpy.mockRestore();
  });
});
