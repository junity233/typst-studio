/**
 * Session memory helpers: capture and restore the full editing session across
 * launches (design spec §13, §16 #8).
 *
 * This is a thin layer over the `get_session` / `save_session` backend commands.
 * The persisted `session.json` lives in the app config dir and is separate from
 * the settings system — it's opaque program state, not user configuration.
 *
 * ## What is captured
 *
 * On every tab open/close/activate/save the frontend re-captures, in display
 * order: each tab's path (→ `Disk`) or content (→ `Untitled`), its dirty flag,
 * and the active view id. Compile results and diagnostics are NOT persisted —
 * they regenerate on startup.
 *
 * All saves are best-effort: a rejected save (e.g. the config dir is briefly
 * locked) is logged but never surfaces to the user, since losing one capture is
 * harmless (the next change re-captures).
 */
import { getSession, saveSession, recordWorkspace as recordWorkspaceBE } from "./tauri";
import type { OpenDocRecord, Session } from "./types";

/**
 * The persisted session, or a default empty one if unreadable. Kept fully
 * populated (all fields) so callers can branch on any field without null checks.
 */
export async function loadSession(): Promise<Session> {
  try {
    return await getSession();
  } catch (e) {
    console.warn("[session] load failed:", e);
    return emptySession();
  }
}

/**
 * Record the last-opened workspace path (§7.2 "最近工作区"). Delegates to the
 * backend `record_workspace` command, which bumps the path to the front of the
 * recent-workspaces list (deduped + capped) AND sets it as the current
 * workspace. Pass "" to clear the current-workspace marker only (the recent
 * list is untouched). Best-effort: a failure is logged, never thrown.
 */
export function recordWorkspace(path: string): void {
  recordWorkspaceBE(path).catch((e) =>
    console.warn("[session] recordWorkspace failed:", e),
  );
}

/**
 * Record the last-opened file path (pass "" to clear). Kept for backward
 * compat with the legacy single-file hint; the full open-document list is
 * captured separately by [`captureAndSaveSession`].
 */
export function recordFile(path: string): void {
  saveSession({ lastFile: path }).catch((e) =>
    console.warn("[session] recordFile failed:", e),
  );
}

/**
 * Minimal view of a tab needed to capture a session record. Matches the
 * relevant fields of the store's `Tab` so this module can stay free of a static
 * import cycle with the tabs store.
 */
export interface CaptureTab {
  id: string;
  path: string | null;
  content: string;
  dirty: boolean;
}

/**
 * Build the `openDocuments` records (in display order) plus the active id from
 * a snapshot of the tab list. A tab with a path becomes a `Disk` record; a
 * pathless tab becomes an `Untitled` record seeded with its current buffer
 * content. Pure/testable — does not touch the store or the backend.
 *
 * @param tabs the current tab list, in display order.
 * @param activeId the active view id, or null.
 */
export function buildOpenDocuments(
  tabs: ReadonlyArray<CaptureTab>,
  activeId: string | null,
): { openDocuments: OpenDocRecord[]; activeDocumentId: string | null } {
  const openDocuments: OpenDocRecord[] = tabs.map((t) =>
    t.path !== null
      ? { kind: "disk", path: t.path, dirty: t.dirty }
      : { kind: "untitled", content: t.content, dirty: t.dirty },
  );
  // Only carry the active id if it still points at an open tab; otherwise clear
  // it so the restore path falls back to the last-opened view.
  const activeDocumentId =
    activeId !== null && tabs.some((t) => t.id === activeId) ? activeId : null;
  return { openDocuments, activeDocumentId };
}

/**
 * Read the live tab list + active view and persist a full open-documents
 * snapshot. Pure over the injected `readState`/`save` so it is unit-testable
 * without the Tauri runtime or a live store.
 *
 * @param readState returns the current `{ tabs, activeId }`.
 * @param save     persists a session patch; should be `saveSession`.
 */
export async function captureSession(
  readState: () => { tabs: ReadonlyArray<CaptureTab>; activeId: string | null },
  save: (patch: {
    openDocuments: OpenDocRecord[];
    activeDocumentId: string | null;
  }) => Promise<unknown>,
  discardedIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const { tabs, activeId } = readState();
  // "Don't Save" means an untitled buffer must disappear, while a disk-backed
  // document may still be reopened from disk but must no longer be marked
  // dirty. The final close capture is authoritative over earlier best-effort
  // captures that may still contain the discarded in-memory text.
  const capturedTabs = tabs.flatMap((tab) => {
    if (!discardedIds.has(tab.id)) return [tab];
    return tab.path === null ? [] : [{ ...tab, dirty: false }];
  });
  const { openDocuments, activeDocumentId } = buildOpenDocuments(
    capturedTabs,
    activeId,
  );
  await save({ openDocuments, activeDocumentId });
}

/**
 * Capture the current tab list + active view into the persisted session.
 * Best-effort: a failure is logged but never thrown. The store is imported
 * lazily (dynamic import) so this module stays free of a static cycle with the
 * tabs store (which imports `recordFile` from here). The core work is delegated
 * to the injectable [`captureSession`] so it can be unit-tested directly.
 */
export async function captureAndSaveSession(
  discardedIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  try {
    // Read the live view order + domain state. The tabs store is now a views
    // store (ids only); the domain fields come from documentsStore via
    // `readOrderedDocuments`, which snapshots both stores once. Imported
    // lazily to keep this module free of a static import cycle (the stores
    // import `recordFile` from here).
    const { useTabsStore, readOrderedDocuments } = await import(
      "../store/tabsStore"
    );
    await captureSession(
      () => ({ tabs: readOrderedDocuments(), activeId: useTabsStore.getState().activeId }),
      saveSession,
      discardedIds,
    );
  } catch (e) {
    // Never surface: losing one capture is harmless (the next change
    // re-captures). Just warn so a persistent failure is visible in dev.
    console.warn("[session] captureAndSaveSession failed:", e);
  }
}

/**
 * Result of restoring a single document: the record it came from, the new tab
 * id, and whether it should be re-marked dirty.
 */
export interface RestoredDoc {
  record: OpenDocRecord;
  id: string;
  dirty: boolean;
}

/**
 * The document-opening operations [`restoreOpenDocuments`] needs. Injected so
 * the restore logic is unit-testable without the Tauri runtime or a live store.
 *
 * - `openDisk(path)` → opens a disk file, returns its new tab id, or `null` to
 *   SKIP this record (e.g. when crash-recovery already opened it as a dirty
 *   in-memory doc — §5.1.3 recovery wins over session).
 * - `openUntitled(content)` → opens an untitled buffer, returns its new tab id.
 */
export interface RestoreOps {
  openDisk: (path: string) => Promise<string | null>;
  openUntitled: (content: string) => Promise<string>;
}

/**
 * Outcome of a restore pass: the docs that reopened successfully (in order),
 * and the per-document failures (record + error) so the caller can surface them.
 */
export interface RestoreOutcome {
  restored: RestoredDoc[];
  failures: Array<{ record: OpenDocRecord; error: unknown }>;
}

/**
 * Replay the persisted open-document list, reopening each in order (§13).
 * Disk files open by path via the unified open path; untitled buffers open by
 * content. Recovery is per-document: a file that no longer exists or is
 * unreadable is caught and reported in `failures`, and does NOT block the rest.
 *
 * Pure over `ops` + the session — does not touch the store or the Tauri
 * runtime — so it is straightforward to unit-test. The active-view + dirty
 * re-mark steps are left to the caller (they need store/IPC wiring).
 */
export async function restoreOpenDocuments(
  records: ReadonlyArray<OpenDocRecord>,
  ops: RestoreOps,
): Promise<RestoreOutcome> {
  const restored: RestoredDoc[] = [];
  const failures: RestoreOutcome["failures"] = [];
  for (const record of records) {
    try {
      if (record.kind === "disk") {
        const id = await ops.openDisk(record.path);
        // `null` means the caller deliberately skipped this record (e.g.
        // crash-recovery already covered it — §5.1.3). Don't push it to the
        // restored list; it's neither a success nor a failure.
        if (id === null) continue;
        restored.push({ record, id, dirty: record.dirty });
      } else {
        const id = await ops.openUntitled(record.content);
        restored.push({ record, id, dirty: record.dirty });
      }
    } catch (e) {
      failures.push({ record, error: e });
    }
  }
  return { restored, failures };
}

/** A default empty session (all fields zeroed). */
export function emptySession(): Session {
  return {
    // schemaVersion is backend-managed (§7.3); the FE never persists it. We
    // surface it here only because the generated Session type requires it. 0
    // is the "unknown / pre-versioning" sentinel, matching how an absent field
    // deserializes on the backend.
    schemaVersion: 0,
    lastWorkspace: "",
    lastFile: "",
    openDocuments: [],
    activeDocumentId: null,
    // v2 fields default to absent (None/empty) — the backend fills them in.
    windowBounds: null,
    layout: null,
    recentWorkspaces: [],
  };
}
