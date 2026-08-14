import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTauriListenerHandle,
  type TauriListenerHandle,
} from "../useTauriListener";

/**
 * The race-safe registration protocol behind `useTauriListener`.
 *
 * Tauri's `onX(handler)` resolves its unlisten fn asynchronously, so
 * "component unmounted before the promise resolved" is a real ordering: the
 * handle must make `resolved` and `dispose` commutative — whichever order they
 * arrive in, the unlisten runs exactly once and a failed registration is
 * logged instead of becoming an unhandled rejection (which would silently
 * kill the event chain).
 */
describe("createTauriListenerHandle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases the listener on dispose after resolution (normal unmount)", () => {
    const unlisten = vi.fn();
    const h = createTauriListenerHandle("test");
    h.resolved(unlisten);
    expect(unlisten).not.toHaveBeenCalled();
    h.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases the listener when resolution lands AFTER dispose (the race)", () => {
    // The component unmounted before the subscribe promise resolved: the
    // naive `unlisten?.()` cleanup would have missed this fn entirely and
    // leaked the listener.
    const unlisten = vi.fn();
    const h = createTauriListenerHandle("test");
    h.dispose();
    expect(unlisten).not.toHaveBeenCalled();
    h.resolved(unlisten);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("never double-releases: dispose is idempotent", () => {
    const unlisten = vi.fn();
    const h = createTauriListenerHandle("test");
    h.resolved(unlisten);
    h.dispose();
    h.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("swallows nothing on dispose without resolution (no unlisten held)", () => {
    const h = createTauriListenerHandle("test");
    expect(() => h.dispose()).not.toThrow();
  });

  it("logs a registration failure with the source name (no silent dead chain)", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const h = createTauriListenerHandle("onCompiled");
    h.failed(new Error("ipc down"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("onCompiled");
  });

  it("stays quiet when the failure lands after dispose", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const h: TauriListenerHandle = createTauriListenerHandle("onCompiled");
    h.dispose();
    h.failed(new Error("ipc down"));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
