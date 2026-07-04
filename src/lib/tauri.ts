import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConflictPayload,
  DeleteResult,
  DirEntry,
  DocsReboundPayload,
  DocumentId,
  EntryKind,
  FocusViewPayload,
  FsChangedPayload,
  LayoutState,
  OpenExternalFilePayload,
  OpenedDocument,
  OpenDocRecord,
  RecoverableInfo,
  RecoveredDocument,
  RecoveryAvailablePayload,
  CompareRecovery,
  ReboundDoc,
  SaveAllResult,
  SaveState,
  SaveStateChangedPayload,
  Session,
  StartupProblem,
  StartupProblemsPayload,
  ThemesChangedPayload,
  ThemeInfo,
  WindowBounds,
  WorkspaceMeta,
} from "./types";
import type {
  CompiledPayload,
  DiagnosticsPayload,
  MenuEventPayload,
  StatusPayload,
  LspStatusPayload,
} from "./ui-types";
import type { Manifest } from "./settings-types";

/**
 * Create an untitled document on the backend.
 * Pass `content` to seed it; omit to let the backend use its default template.
 * Returns the new tab's metadata plus its current source text.
 */
export async function newTab(content?: string): Promise<OpenedDocument> {
  return invoke<OpenedDocument>("new_tab", content !== undefined ? { content } : {});
}

/**
 * Open a file via the native dialog. Returns the document meta + content, or
 * null if the user cancelled.
 */
export async function openFile(): Promise<OpenedDocument | null> {
  return invoke<OpenedDocument | null>("open_file");
}

/** Close the document on the backend, releasing its world/resources. */
export async function closeTab(id: DocumentId): Promise<void> {
  await invoke("close_tab", { id });
}

/** Push the latest source text to the backend (debounced by caller). */
export async function updateText(
  id: DocumentId,
  content: string,
): Promise<void> {
  await invoke("update_text", { id, content });
}

/** Persist the document's source to its on-disk path (errors on untitled). */
export async function saveFile(id: DocumentId): Promise<void> {
  await invoke("save_file", { id });
}

/**
 * Save As: write a tab's text to a new file via a save dialog, then make the
 * tab file-backed at that path. Returns the new absolute path.
 */
export async function saveAs(id: DocumentId): Promise<string> {
  return invoke<string>("save_as", { id });
}

/**
 * Query the current save state (§5.3) for a document. The frontend mirrors
 * transitions via `onSaveStateChanged`; this is the poll/fetch fallback (e.g.
 * on initial load). Absent docs read as `{ kind: "idle" }`.
 */
export async function getSaveState(id: DocumentId): Promise<SaveState> {
  return invoke<SaveState>("save_state", { id });
}

/**
 * Save All (§5.3): save each document in `ids` in order. Stops on the first
 * failure or cancel; already-saved docs stay saved, the rest untouched. Returns
 * the per-doc split so the UI can report which need attention.
 */
export async function saveAll(ids: DocumentId[]): Promise<SaveAllResult> {
  return invoke<SaveAllResult>("save_all", { ids });
}

/**
 * Render the document to a PDF via typst-pdf; returns the saved path.
 *
 * `revision` (§9) pins the export to the revision the user is looking at: the
 * backend renders that revision's compiled document, waiting if it is still
 * mid-compile (bounded by a timeout) and erroring if it failed — never silently
 * rendering an older revision's document. The caller passes the tab's current
 * `revision`.
 */
export async function exportPdf(id: DocumentId, revision: number): Promise<string> {
  return invoke<string>("export_pdf", { id, revision });
}

/**
 * Render each page to a PNG via typst-render; returns the saved paths. See
 * [`exportPdf`] for the `revision` semantics (§9).
 */
export async function exportPng(id: DocumentId, revision: number): Promise<string[]> {
  return invoke<string[]>("export_png", { id, revision });
}

/**
 * Render each page to an SVG via typst-svg; returns the saved paths. See
 * [`exportPdf`] for the `revision` semantics (§9).
 */
export async function exportSvg(id: DocumentId, revision: number): Promise<string[]> {
  return invoke<string[]>("export_svg", { id, revision });
}

// --- Workspace / filesystem -------------------------------------------------

/** Open a folder via a native dialog and set it as the workspace. */
export async function openWorkspace(): Promise<WorkspaceMeta | null> {
  return invoke<WorkspaceMeta | null>("open_workspace");
}

/** Close the current workspace (stops the watcher; tabs are untouched). */
export async function closeWorkspace(): Promise<void> {
  await invoke("close_workspace");
}

/**
 * Open the process's current working directory as the workspace — the default
 * when no folder has been picked. Returns the metadata, or null if the cwd
 * can't be determined.
 */
export async function openDefaultWorkspace(): Promise<WorkspaceMeta | null> {
  return invoke<WorkspaceMeta | null>("open_default_workspace");
}

/**
 * Open `path` as the workspace without a dialog (used to restore the last
 * workspace on startup). Returns null if the path is missing/not a directory.
 */
export async function openWorkspaceByPath(
  path: string,
): Promise<WorkspaceMeta | null> {
  return invoke<WorkspaceMeta | null>("open_workspace_by_path", { path });
}

/** Query the current workspace metadata, or null if no folder is open. */
export async function getWorkspace(): Promise<WorkspaceMeta | null> {
  return invoke<WorkspaceMeta | null>("get_workspace");
}

/**
 * List the immediate children of a workspace-relative directory (`""` or
 * undefined = root). Returns dirs first, then files (both alphabetical).
 */
export async function readDir(rel?: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir", { rel: rel ?? "" });
}

/** Create a file or directory at a workspace-relative path. */
export async function createEntry(rel: string, kind: EntryKind): Promise<void> {
  await invoke("create_entry", { rel, kind });
}

/**
 * Rename/move a workspace-relative entry to another workspace-relative path.
 * §6.4 联动: the backend rebinds every open doc under `from` to the matching
 * path under `to` (registry/world/VFS/watcher). Returns the rebound docs so a
 * caller can mirror the path change into frontend stores (the `docs_rebound`
 * event also carries them — either source is authoritative).
 */
export async function renameEntry(
  from: string,
  to: string,
): Promise<ReboundDoc[]> {
  return invoke<ReboundDoc[]>("rename_entry", { from, to });
}

/**
 * Delete a workspace-relative file or directory via the system trash (§5.5).
 * Rejects with `delete_blocked` when a dirty document is open under the target
 * (the user must save/close/discard it first); resolves with the outcome
 * (`"trashed"` / `"permanently_deleted"`) otherwise.
 */
export async function deleteEntry(rel: string): Promise<DeleteResult> {
  return invoke<DeleteResult>("delete_entry", { rel });
}

/** Reveal a workspace-relative file or directory in the OS file manager. */
export async function revealInFinder(rel: string): Promise<void> {
  await invoke("reveal_in_finder", { rel });
}

/**
 * Open a file by absolute path (no dialog) as a tab — used by file-tree clicks.
 * If the path is inside the open workspace, the tab compiles with #include
 * resolution; otherwise it's a detached single-file tab.
 */
export async function openFileByPath(path: string): Promise<OpenedDocument> {
  return invoke<OpenedDocument>("open_file_by_path", { path });
}

// --- Event subscriptions ----------------------------------------------------

/** Subscribe to compiled (svg pages) events. Returns an unlisten function. */
export async function onCompiled(
  handler: (payload: CompiledPayload) => void,
): Promise<UnlistenFn> {
  return listen<CompiledPayload>("compiled", (e) => handler(e.payload));
}

/** Subscribe to diagnostics events. Returns an unlisten function. */
export async function onDiagnostics(
  handler: (payload: DiagnosticsPayload) => void,
): Promise<UnlistenFn> {
  return listen<DiagnosticsPayload>("diagnostics", (e) => handler(e.payload));
}

/** Subscribe to status events. Returns an unlisten function. */
export async function onStatus(
  handler: (payload: StatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<StatusPayload>("status", (e) => handler(e.payload));
}

/** Subscribe to LSP status events (connect/disconnect transitions). */
export async function onLspStatus(
  handler: (payload: LspStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<LspStatusPayload>("lsp_status", (e) => handler(e.payload));
}

/** Subscribe to filesystem-change events (live file-tree refresh). */
export async function onFsChanged(
  handler: (payload: FsChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<FsChangedPayload>("fs_changed", (e) => handler(e.payload));
}

/**
 * Subscribe to theme-list change events. Emitted by the backend watcher
 * whenever the user themes directory changes (a theme added/removed/edited),
 * carrying the full refreshed theme list. The frontend replaces its picker
 * options and re-applies the current theme's CSS.
 */
export async function onThemesChanged(
  handler: (payload: ThemesChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<ThemesChangedPayload>("themes_changed", (e) => handler(e.payload));
}

/**
 * Subscribe to docs-rebound events (§6.4). Emitted after a rename/move rebinds
 * open documents to their new paths; the handler mirrors the new path into the
 * frontend document store (tab title, breadcrumb, active-file highlight).
 */
export async function onDocsRebound(
  handler: (payload: DocsReboundPayload) => void,
): Promise<UnlistenFn> {
  return listen<DocsReboundPayload>("docs_rebound", (e) => handler(e.payload));
}

/**
 * Subscribe to external-modification conflict events (§8.4). Emitted when the
 * filesystem watcher detects a disk change to an open document's backing file
 * that could not be auto-applied (dirty buffer → Modified; deleted → Missing).
 * `diskContent` is present on `Modified` so the UI can show a diff.
 */
export async function onConflict(
  handler: (payload: ConflictPayload) => void,
): Promise<UnlistenFn> {
  return listen<ConflictPayload>("conflict", (e) => handler(e.payload));
}

/**
 * Subscribe to per-document save-state transitions (§5.3). The backend
 * `SaveCoordinator` emits `save_state_changed` on every `Idle`/`Saving`/`Saved`
 * /`Failed` transition so the frontend can drive a saving indicator + red
 * save-failed status. The frontend mirrors these into `saveStateStore`.
 */
export async function onSaveStateChanged(
  handler: (payload: SaveStateChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SaveStateChangedPayload>("save_state_changed", (e) =>
    handler(e.payload),
  );
}

/** Subscribe to native menu activation events. */
export async function onMenuEvent(
  handler: (payload: MenuEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<MenuEventPayload>("menu_event", (e) => handler(e.payload));
}

// --- Settings ----------------------------------------------------------------

/** Fetch the whole runtime settings object. */
export async function getAllSettings(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("get_all_settings");
}

/** Write one setting by dot-path; persists + broadcasts `settings_changed`. */
export async function setSetting(
  path: string,
  value: unknown,
): Promise<void> {
  await invoke("set_setting", { path, value });
}

/** Fetch the settings manifest (the descriptor that drives the settings UI). */
export async function getSettingsManifest(): Promise<Manifest> {
  return invoke<Manifest>("get_settings_manifest");
}

/** Create or focus the dedicated settings window. */
export async function openSettings(): Promise<void> {
  await invoke("open_settings");
}

/**
 * Open the diagnostic log directory in the OS file manager (§7.4). Returns the
 * resolved directory path. Used by the Settings "Open log directory" action.
 */
export async function openLogDir(): Promise<string> {
  return invoke<string>("open_log_dir");
}

// --- Themes ------------------------------------------------------------------

/**
 * List discovered user themes (folder name + metadata). The built-in `default`
 * theme is implicit and not included here — the frontend prepends it in the
 * picker. Returns an empty array when no themes exist or the directory is
 * absent.
 */
export async function listThemes(): Promise<ThemeInfo[]> {
  return invoke<ThemeInfo[]>("list_themes");
}

/**
 * Read the CSS source for one theme. Returns `null` for the built-in default
 * theme or any unreadable/unknown id (the caller falls back to default by
 * removing the user-theme `<style>`).
 */
export async function getThemeCss(id: string): Promise<string | null> {
  return invoke<string | null>("get_theme_css", { id });
}

/**
 * Open the user themes directory in the OS file manager so the user can
 * create/edit theme folders. Returns the resolved directory path.
 */
export async function openThemesDir(): Promise<string> {
  return invoke<string>("open_themes_dir");
}

/**
 * Subscribe to whole-config broadcasts. Emitted to ALL windows on every
 * successful `set_setting`, carrying the full runtime config object. Returns
 * an unlisten function (same shape as the other `on*` wrappers).
 */
export async function onSettingsChanged(
  handler: (data: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return listen<Record<string, unknown>>("settings_changed", (e) =>
    handler(e.payload),
  );
}

/**
 * Subscribe to Settings window visibility. The backend broadcasts
 * `{ open }` when the Settings window is created/destroyed so the main window
 * can show a modal overlay (it floats `always_on_top`, but Tauri has no native
 * cross-platform modal that blocks parent input).
 */
export async function onSettingsWindow(
  handler: (open: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ open: boolean }>("settings_window", (e) =>
    handler(e.payload.open),
  );
}

/**
 * Subscribe to the main window's close request. The backend intercepts the OS
 * close (traffic light / Cmd+Q / Alt+F4) on the `main` window, prevents the
 * actual close, and emits this event so the frontend can decide: close
 * immediately, or show a Save-All confirmation when there are dirty tabs.
 */
export async function onCloseRequested(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("close_requested", () => handler());
}

// --- Single-instance file routing (§6.1) ------------------------------------

/**
 * Subscribe to `focus_view`: a second app instance requested a file that is
 * already open — activate its tab. Emitted by the single-instance plugin
 * callback when the canonical path matches an existing document.
 */
export async function onFocusView(
  handler: (payload: FocusViewPayload) => void,
): Promise<UnlistenFn> {
  return listen<FocusViewPayload>("focus_view", (e) => handler(e.payload));
}

/**
 * Subscribe to `open_external_file`: a second app instance requested a file
 * that is not yet open — open a new tab at the absolute `path` via the existing
 * `openFileByPath` flow. Emitted by the single-instance plugin callback.
 */
export async function onOpenExternalFile(
  handler: (payload: OpenExternalFilePayload) => void,
): Promise<UnlistenFn> {
  return listen<OpenExternalFilePayload>("open_external_file", (e) =>
    handler(e.payload),
  );
}

// --- Startup problems (§6.5) ------------------------------------------------

/**
 * Subscribe to `startup_problems`: emitted once at end of setup when one or
 * more startup components degraded (config dir, settings, session). The payload
 * carries a list of non-fatal problems for a non-modal banner. Empty list → no
 * event is emitted.
 */
export async function onStartupProblems(
  handler: (payload: StartupProblem[]) => void,
): Promise<UnlistenFn> {
  return listen<StartupProblemsPayload>("startup_problems", (e) =>
    handler(e.payload.problems),
  );
}

// --- Session memory ----------------------------------------------------------

/**
 * The persisted session (§13). Re-exported from the generated `types.ts` so the
 * frontend and backend stay in sync via ts-rs. Captures the last workspace,
 * every open document (disk path or untitled content) in display order, and the
 * active view id.
 */
export type { Session } from "./types";

/** Read the persisted session. Missing/malformed file → an empty session. */
export async function getSession(): Promise<Session> {
  return invoke<Session>("get_session");
}

/**
 * Merge a partial update into the session. Only present fields are applied by
 * the backend (`lastWorkspace`, `lastFile`, `openDocuments`, `activeDocumentId`,
 * `windowBounds`, `layout`, `recentWorkspaces`); a wrong-type field is skipped,
 * not fatal. The capture path always sends a full `openDocuments` array +
 * `activeDocumentId`, replacing the prior values wholesale. v2 fields
 * (`windowBounds`/`layout`) are set with `null` to clear them.
 */
export async function saveSession(patch: {
  lastWorkspace?: string;
  lastFile?: string;
  openDocuments?: OpenDocRecord[];
  activeDocumentId?: string | null;
  windowBounds?: Partial<WindowBounds> | null;
  layout?: Partial<LayoutState> | null;
  recentWorkspaces?: string[];
}): Promise<Session> {
  return invoke<Session>("save_session", { patch });
}

/**
 * Record that the user opened `workspace` (§7.2 "最近工作区"): bumps it to the
 * front of the recent list (deduped + capped at 10) and sets it as the current
 * workspace. Pass "" to clear the current-workspace marker only. Returns the
 * new session snapshot. Best-effort callers can ignore the result.
 */
export async function recordWorkspace(workspace: string): Promise<Session> {
  return invoke<Session>("record_workspace", { workspace });
}

/**
 * Clear the recent-workspaces list (§9 "清除最近记录"). When
 * `alsoClearRecovery` is true, ALL recovery snapshots are wiped first (§9
 * "清除最近记录时可选择同时清除恢复数据"). Returns the new session snapshot.
 */
export async function clearRecentWorkspaces(
  alsoClearRecovery: boolean,
): Promise<Session> {
  return invoke<Session>("clear_recent_workspaces", {
    alsoClearRecovery,
  });
}

/**
 * Set a tab's dirty flag (§13). Used by the session-restore path to re-mark a
 * restored document dirty when it was dirty at shutdown (for a disk file this
 * signals "you had unsaved edits at shutdown that are now lost"). No-op if the
 * tab is not open.
 */
export async function setDirty(
  id: DocumentId,
  dirty: boolean,
): Promise<void> {
  await invoke("set_dirty", { id, dirty });
}

// --- Crash recovery (§5.1) --------------------------------------------------

/**
 * Subscribe to `recovery_available`: emitted once at startup when recoverable
 * snapshots exist (the prior session crashed, or a snapshot is newer than
 * disk). The frontend shows a `RecoveryDialog` with one row per snapshot.
 * Empty payload is never emitted — no event means no recovery offered.
 */
export async function onRecoveryAvailable(
  handler: (payload: RecoveryAvailablePayload) => void,
): Promise<UnlistenFn> {
  return listen<RecoveryAvailablePayload>("recovery_available", (e) =>
    handler(e.payload),
  );
}

/**
 * Re-fetch the recoverable list (§5.1.3). The dialog already receives the list
 * via `onRecoveryAvailable`, but this lets it refresh after a discard.
 */
export async function listRecovery(): Promise<RecoverableInfo[]> {
  return invoke<RecoverableInfo[]>("list_recovery");
}

/**
 * Load one snapshot for an in-memory document rebuild (§5.1.3). Does NOT write
 * disk — recovery creates a dirty in-memory doc from the snapshot content.
 */
export async function recoverDocument(
  id: string,
): Promise<RecoveredDocument> {
  return invoke<RecoveredDocument>("recover_document", { id });
}

/**
 * Delete one recovery snapshot (§5.1.4 "Don't Save"). The content will not be
 * recoverable on the next launch. Idempotent.
 */
export async function discardRecovery(id: string): Promise<void> {
  await invoke("discard_recovery", { id });
}

/** Delete ALL recovery snapshots (the dialog's "Discard All"). Idempotent. */
export async function discardAllRecovery(): Promise<void> {
  await invoke("discard_all_recovery");
}

/**
 * Load both the snapshot content and the current disk content for a doc, so the
 * UI can show a read-only side-by-side compare (§5.1.3 "比较"). `disk` is null
 * when the file is missing or has no canonical path (Untitled).
 */
export async function compareRecovery(id: string): Promise<CompareRecovery> {
  return invoke<CompareRecovery>("compare_recovery", { id });
}

/**
 * Write the clean-shutdown marker (§5.1.2). Called by the close guard right
 * before `window.destroy()`, after all dirty docs are saved or discarded. The
 * marker tells the next launch that this session ended cleanly (no recovery
 * offered unless a newer-than-disk snapshot still exists).
 */
export async function markCleanShutdown(): Promise<void> {
  await invoke("mark_clean_shutdown");
}

// --- Conflict resolution (§5.4) ---------------------------------------------

/**
 * Resolve a conflict by adopting the DISK version (§5.4 使用磁盘版本): replace
 * the buffer with the current on-disk content, bump revision, clear dirty +
 * conflict. Returns the disk content that was loaded so the caller can hydrate
 * its local copy. Rejects with NotFound/InvalidInput for Missing /
 * PermissionChanged (no readable disk version) — the dialog then offers
 * recreate / Save As.
 */
export async function resolveConflictUseDisk(
  id: DocumentId,
): Promise<string> {
  return invoke<string>("resolve_conflict_use_disk", { id });
}

/**
 * Resolve a conflict by OVERWRITING the disk with the current buffer (§5.4 覆盖
 * 磁盘): the explicit "I know the disk changed; overwrite it" action. Runs the
 * full §5.2 atomic-save protocol, BYPASSING the conflict gate that blocks the
 * normal `saveFile`. On success the conflict + dirty are cleared. Rejects with a
 * structured IpcError on write failure (dirty stays true — §11.2).
 */
export async function resolveConflictOverwrite(
  id: DocumentId,
): Promise<void> {
  await invoke("resolve_conflict_overwrite", { id });
}

/**
 * Clear the conflict flag WITHOUT touching the buffer or dirty state (§5.4 稍后
 * 处理 / discard). The in-place save STAYS blocked (the doc is still
 * "conflicted" from the gate's perspective once re-detected), but the dialog
 * closes and the user keeps editing. Idempotent.
 */
export async function clearConflict(id: DocumentId): Promise<void> {
  await invoke("clear_conflict", { id });
}

// --- Paste-feature: remote image download -----------------------------------

/** Download a remote URL to a local file via the backend net module. */
export async function fetchUrlToFile(url: string, dest: string): Promise<number> {
  return invoke<number>("fetch_url_to_file", { url, dest });
}
