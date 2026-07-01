import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DocumentId, OpenedDocument } from "./types";
import type {
  CompiledPayload,
  DiagnosticsPayload,
  StatusPayload,
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

/** Render the document to a PDF via typst-pdf; returns the saved path. */
export async function exportPdf(id: DocumentId): Promise<string> {
  return invoke<string>("export_pdf", { id });
}

/** Render each page to a PNG via typst-render; returns the saved paths. */
export async function exportPng(id: DocumentId): Promise<string[]> {
  return invoke<string[]>("export_png", { id });
}

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
