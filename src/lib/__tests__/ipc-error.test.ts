import { describe, it, expect, vi, afterEach } from "vitest";
import {
  toIpcError,
  isIpcError,
  isCancelled,
  formatSaveErrorMessage,
  SAVE_AS_RECOVERY_CODES,
  alertIpcError,
  extractDetailPaths,
} from "../ipc-error";
import type { IpcError } from "../ipc-error";

/**
 * §5.3: the backend now rejects with a structured IpcError object (not a
 * string). `toIpcError` must narrow an `unknown` rejection back to a typed
 * IpcError, with a safe fallback for strings/unknown shapes. `cancelled` must
 * be detectable so the save-error UI can no-op on it.
 */

describe("toIpcError", () => {
  it("narrows a real-shaped IpcError object", () => {
    const real: IpcError = {
      code: "permission_denied",
      message: "Permission denied",
      recoverable: false,
    };
    const got = toIpcError(real);
    expect(got.code).toBe("permission_denied");
    expect(got.message).toBe("Permission denied");
    expect(got.recoverable).toBe(false);
  });

  it("preserves structured details", () => {
    const real = {
      code: "already_open" as const,
      message: "document already open",
      details: { existingId: "abc", path: "/x.typ" },
      recoverable: true,
    };
    const got = toIpcError(real);
    expect(got.details).toEqual({ existingId: "abc", path: "/x.typ" });
    expect(got.recoverable).toBe(true);
  });

  it("defaults recoverable to true when absent on the wire", () => {
    const got = toIpcError({ code: "other", message: "boom" });
    expect(got.recoverable).toBe(true);
  });

  it("returns fallback for a string", () => {
    const got = toIpcError("legacy string error");
    expect(got.code).toBe("other");
    expect(got.message).toBe("legacy string error");
    expect(got.recoverable).toBe(true);
  });

  it("returns fallback for an Error instance", () => {
    const got = toIpcError(new Error("boom"));
    expect(got.code).toBe("other");
    expect(got.message).toBe("boom");
  });

  it("returns fallback for an unknown shape", () => {
    const got = toIpcError({ weird: true });
    expect(got.code).toBe("other");
    expect(got.message).toBe("[object Object]");
    expect(got.recoverable).toBe(true);
  });

  it("returns fallback for null/undefined", () => {
    expect(toIpcError(null).code).toBe("other");
    expect(toIpcError(undefined).code).toBe("other");
  });
});

describe("isIpcError", () => {
  it("true for a well-shaped object", () => {
    expect(isIpcError({ code: "other", message: "x" })).toBe(true);
  });

  it("false for missing code", () => {
    expect(isIpcError({ message: "x" })).toBe(false);
  });

  it("false for non-string code", () => {
    expect(isIpcError({ code: 42, message: "x" })).toBe(false);
  });

  it("false for null/string", () => {
    expect(isIpcError(null)).toBe(false);
    expect(isIpcError("x")).toBe(false);
  });
});

describe("isCancelled", () => {
  it("true for a cancelled IpcError", () => {
    expect(isCancelled({ code: "cancelled", message: "user dismissed" })).toBe(true);
  });

  it("false for a permission error", () => {
    expect(
      isCancelled({ code: "permission_denied", message: "no" }),
    ).toBe(false);
  });

  it("false for a legacy string", () => {
    expect(isCancelled("boom")).toBe(false);
  });
});

describe("formatSaveErrorMessage", () => {
  it("permission_denied offers Save As phrasing", () => {
    const msg = formatSaveErrorMessage({
      code: "permission_denied",
      message: "denied",
      recoverable: false,
    });
    expect(msg.toLowerCase()).toContain("permission");
    expect(msg.toLowerCase()).toContain("save as");
  });

  it("disk_full mentions space", () => {
    const msg = formatSaveErrorMessage({
      code: "disk_full",
      message: "ENOSPC",
      recoverable: true,
    });
    expect(msg.toLowerCase()).toContain("space");
  });

  it("read_only mentions Save As", () => {
    const msg = formatSaveErrorMessage({
      code: "read_only",
      message: "ro",
      recoverable: false,
    });
    expect(msg.toLowerCase()).toContain("read-only");
  });

  it("cancelled returns empty string (silent)", () => {
    expect(
      formatSaveErrorMessage({ code: "cancelled", message: "x", recoverable: false }),
    ).toBe("");
  });

  it("unknown code falls back to message", () => {
    const msg = formatSaveErrorMessage({
      code: "io_transient",
      message: " transient hiccup",
      recoverable: true,
    });
    expect(msg).toBe(" transient hiccup");
  });

  it("narrows a raw unknown too", () => {
    // Passing a string (legacy) → fallback other → message preserved.
    expect(formatSaveErrorMessage("legacy")).toBe("legacy");
  });
});

describe("SAVE_AS_RECOVERY_CODES", () => {
  it("includes permission_denied and read_only", () => {
    expect(SAVE_AS_RECOVERY_CODES.has("permission_denied")).toBe(true);
    expect(SAVE_AS_RECOVERY_CODES.has("read_only")).toBe(true);
    expect(SAVE_AS_RECOVERY_CODES.has("path_occupied")).toBe(true);
  });

  it("does not include disk_full (retry, not Save As)", () => {
    expect(SAVE_AS_RECOVERY_CODES.has("disk_full")).toBe(false);
  });
});

describe("alertIpcError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("alerts the errors-namespace message with the narrowed IPC message", () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    alertIpcError("couldNotOpen", { code: "io_transient", message: "disk went away" });
    expect(alert).toHaveBeenCalledOnce();
    const text = alert.mock.calls[0][0] as string;
    expect(text).toContain("disk went away");
  });

  it("passes extra interpolation params (name/label) through", () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    alertIpcError(
      "couldNotOpenFile",
      { code: "io_transient", message: "boom" },
      { name: "main.typ" },
    );
    const text = alert.mock.calls[0][0] as string;
    expect(text).toContain("main.typ");
    expect(text).toContain("boom");
  });

  it("narrows non-IpcError rejections instead of alerting [object Object]", () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    alertIpcError("actionFailed", new Error("legacy"));
    const text = alert.mock.calls[0][0] as string;
    expect(text).toContain("legacy");
    expect(text).not.toContain("[object Object]");
  });
});

describe("extractDetailPaths", () => {
  it("pulls the path strings out of a details array", () => {
    const details = {
      affectedDocs: [
        { id: "a", path: "/w/a.typ" },
        { id: "b", path: "/w/b.typ" },
      ],
    };
    expect(extractDetailPaths(details, "affectedDocs")).toEqual([
      "/w/a.typ",
      "/w/b.typ",
    ]);
  });

  it("drops entries without a string path", () => {
    const details = { openDocs: [{ id: "a" }, { path: 42 }, "junk", null] };
    expect(extractDetailPaths(details, "openDocs")).toEqual([]);
  });

  it("returns [] for missing key / non-array / non-object details", () => {
    expect(extractDetailPaths({ openDocs: "nope" }, "openDocs")).toEqual([]);
    expect(extractDetailPaths(null, "openDocs")).toEqual([]);
    expect(extractDetailPaths(undefined, "openDocs")).toEqual([]);
    expect(extractDetailPaths({}, "affectedDocs")).toEqual([]);
  });
});
