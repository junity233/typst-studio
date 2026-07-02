/**
 * Session memory helpers: record/restore the last-opened workspace and file.
 *
 * This is a thin convenience layer over the `get_session` / `save_session`
 * backend commands. The persisted `session.json` lives in the app config dir
 * and is separate from the settings system — it's opaque program state, not
 * user configuration.
 *
 * All calls are fire-and-forget-friendly: a rejected save (e.g. the config dir
 * is briefly locked) is logged but never surfaces to the user, since losing a
 * "last opened" hint is harmless.
 */
import { getSession, saveSession, type Session } from "./tauri";

/** The persisted session, or a default empty one if unreadable. */
export async function loadSession(): Promise<Session> {
  try {
    return await getSession();
  } catch (e) {
    console.warn("[session] load failed:", e);
    return { lastWorkspace: "", lastFile: "" };
  }
}

/** Record the last-opened workspace path (pass "" to clear). */
export function recordWorkspace(path: string): void {
  saveSession({ lastWorkspace: path }).catch((e) =>
    console.warn("[session] recordWorkspace failed:", e),
  );
}

/** Record the last-opened file path (pass "" to clear). */
export function recordFile(path: string): void {
  saveSession({ lastFile: path }).catch((e) =>
    console.warn("[session] recordFile failed:", e),
  );
}
