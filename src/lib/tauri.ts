import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DirEntry,
  DocumentId,
  EntryKind,
  FsChangedPayload,
  OpenedDocument,
  WorkspaceMeta,
} from "./types";
import type {
  CompiledPayload,
  DiagnosticsPayload,
  MenuEventPayload,
  StatusPayload,
  LspStatusPayload,
} from "./ui-types";

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

/** Render the document to a PDF via typst-pdf; returns the saved path. */
export async function exportPdf(id: DocumentId): Promise<string> {
  return invoke<string>("export_pdf", { id });
}

/** Render each page to a PNG via typst-render; returns the saved paths. */
export async function exportPng(id: DocumentId): Promise<string[]> {
  return invoke<string[]>("export_png", { id });
}

/** Render each page to an SVG via typst-svg; returns the saved paths. */
export async function exportSvg(id: DocumentId): Promise<string[]> {
  return invoke<string[]>("export_svg", { id });
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

/** Rename/move a workspace-relative entry to another workspace-relative path. */
export async function renameEntry(from: string, to: string): Promise<void> {
  await invoke("rename_entry", { from, to });
}

/** Delete a workspace-relative file or directory. */
export async function deleteEntry(rel: string): Promise<void> {
  await invoke("delete_entry", { rel });
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

/** Subscribe to native menu activation events. */
export async function onMenuEvent(
  handler: (payload: MenuEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<MenuEventPayload>("menu_event", (e) => handler(e.payload));
}
