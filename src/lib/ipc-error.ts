/**
 * Structured IPC error handling (§5.3).
 *
 * The backend serializes `AppError` as a JSON **object** `{ code, message,
 * details?, recoverable }` (see `src-tauri/src/ipc/error.rs`), not a string.
 * Tauri's `invoke` rejects with that object directly, so a `.catch(e)` receives
 * an `unknown` that is actually an `IpcError`. [`toIpcError`] narrows it
 * defensively: a real-shaped object passes through; a string or unknown shape
 * yields a safe fallback so callers always have a typed error to branch on.
 */
import type { ErrorCode } from "./types";

/**
 * Frontend-side `IpcError` shape. Mirrors the generated `types.ts` `IpcError`
 * but with `details` OPTIONAL — the backend omits it on the wire when `None`
 * (`#[serde(skip_serializing_if = "Option::is_none")]`), and ts-rs emits the
 * field as required, so we declare this looser local view for safe
 * construction. A value of this type is assignable to the generated `IpcError`
 * at use sites that only read it.
 */
export interface IpcError {
  code: ErrorCode;
  message: string;
  /** Optional structured details (absent on the wire when the backend has none). */
  details?: unknown;
  recoverable: boolean;
}

/**
 * Narrow an `unknown` rejection from `invoke` into a typed [`IpcError`].
 *
 * - A real-shaped object (has a string `code` + string `message`) is returned
 *   as-is (details/recoverable defaulted if absent).
 * - A string (legacy callers / non-Tauri throws) becomes a recoverable `other`.
 * - Anything else becomes a recoverable `other` with `String(e)` as the message.
 *
 * Never throws — always returns a valid `IpcError`.
 */
export function toIpcError(e: unknown): IpcError {
  if (isIpcError(e)) {
    return {
      code: e.code,
      message: e.message,
      details: e.details,
      recoverable: e.recoverable ?? true,
    };
  }
  // Legacy string or Error-shaped throw.
  if (typeof e === "string") {
    return { code: "other", message: e, recoverable: true };
  }
  if (e instanceof Error) {
    return { code: "other", message: e.message, recoverable: true };
  }
  return { code: "other", message: String(e), recoverable: true };
}

/**
 * Type guard: does `e` look like an `IpcError` from the backend? Checks the two
 * required fields (`code` string + `message` string); `details` and
 * `recoverable` are optional on the wire.
 */
export function isIpcError(e: unknown): e is IpcError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    typeof (e as { message?: unknown }).message === "string"
  );
}

/**
 * Is `e` (or an `IpcError`) a `Cancelled` error? §5.3: cancellation is not a
 * failure — the save-error UI must no-op on this code (no alert, no banner).
 */
export function isCancelled(e: unknown): boolean {
  return toIpcError(e).code === "cancelled";
}

/**
 * The set of error codes that mean "the user can't overwrite this file as-is" —
 * the UI should offer Save As. Used by the save-failure branch.
 */
export const SAVE_AS_RECOVERY_CODES: ReadonlySet<ErrorCode> = new Set([
  "permission_denied",
  "read_only",
  "path_occupied",
  "external_conflict",
]);

/**
 * Format an `IpcError` into a user-facing message, with code-specific phrasing
 * for the common save failures. Falls back to `message` for unknown codes.
 */
export function formatSaveErrorMessage(e: unknown): string {
  const err = toIpcError(e);
  switch (err.code) {
    case "permission_denied":
      return `Permission denied — Typst Studio can't write to this file. Try Save As to a writable location.`;
    case "read_only":
      return `This file is read-only. Use Save As to write to a new location.`;
    case "disk_full":
      return `The disk is full. Free up space and try again, or use Save As to a different volume.`;
    case "parent_missing":
      return `The destination folder doesn't exist. Use Save As to pick a valid location.`;
    case "target_missing":
    case "path_occupied":
    case "external_conflict":
    case "invalid_path":
      return err.message;
    case "cancelled":
      // Caller should no-op on cancelled; if it surfaces anyway, stay quiet.
      return "";
    default:
      return err.message;
  }
}
