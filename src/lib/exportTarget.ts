import { exportPdf, exportPng, exportSvg } from "./tauri";
import { flushDocumentSnapshot } from "./saveDocument";
import { joinWorkspacePath, workspacePathsEqual } from "./workspacePath";
import { expandTemplate } from "./pathMacros";
import { useTabsStore } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useProjectConfigStore } from "../store/projectConfigStore";

/**
 * Export-target resolution + the shared export runner. Extracted from the
 * workbench extension's `doExport` so the same semantics serve BOTH the
 * manual export commands and auto-export-on-save
 * ([`maybeAutoExportAfterSave`](./saveDocument.ts)):
 *
 * - the export TARGET is the project's main file when one is configured AND
 *   currently open, otherwise the active tab;
 * - the output path honors the project's `[export] outputPath` pattern
 *   (macro-expanded, anchored at the workspace root when relative);
 * - `revision` (§9) pins each export to the target's flushed revision.
 */

export type ExportFormat = "pdf" | "png" | "svg";

/**
 * Resolve the document id to export: the project's main file when one is
 * configured AND currently open, otherwise the active tab. The main file must
 * already be open (have a compiled revision pinned) — opening it on demand
 * here would race the compile. In practice the project-preview flow opens it;
 * if it isn't open, we fall back to the active tab rather than surprising the
 * user.
 */
export function resolveExportTargetId(): string | null {
  const rootPath = useWorkspaceStore.getState().rootPath;
  const main = useProjectConfigStore.getState().config?.main ?? null;
  if (main !== null && rootPath !== null) {
    const mainAbs = joinWorkspacePath(rootPath, main);
    const docs = useDocumentsStore.getState().documents;
    const mainDoc = Object.values(docs).find(
      (d) => d.path !== null && workspacePathsEqual(d.path, mainAbs),
    );
    if (mainDoc) return mainDoc.id;
  }
  return useTabsStore.getState().activeId;
}

/**
 * The project's `[export] outputPath` expanded to an absolute path (macros
 * applied; relative results anchored at the workspace root), or `undefined`
 * when no pattern is configured / no workspace is open. With no configured
 * path the backend falls back to its save dialog.
 */
export function resolveConfiguredOutputPath(): string | undefined {
  const cfg = useProjectConfigStore.getState().config;
  const rootPath = useWorkspaceStore.getState().rootPath;
  const pattern = cfg?.export?.outputPath;
  if (!pattern || !rootPath) return undefined;
  const expanded = expandTemplate(pattern, {
    workspace: rootPath,
    title: cfg.title ?? "",
  });
  // Treat an already-absolute expansion as-is; otherwise anchor at root.
  return /^([A-Za-z]:[\\/]|[\\/])./.test(expanded)
    ? expanded
    : joinWorkspacePath(rootPath, expanded);
}

/** Resolve the project's default export format (`[export] format`), "pdf" if unset. */
export function defaultExportFormat(): ExportFormat {
  const f = useProjectConfigStore.getState().config?.export?.format ?? "pdf";
  return f === "png" || f === "svg" ? f : "pdf";
}

/**
 * Run one export of the resolved target, honoring the project's
 * `[export] outputPath` when `useConfigPath` is set. Mirrors the previous
 * workbench closure 1:1 (target resolution → flush → format dispatch).
 */
export async function runExport(
  format: ExportFormat,
  useConfigPath: boolean,
): Promise<void> {
  const id = resolveExportTargetId();
  if (id === null) return;
  const snapshot = await flushDocumentSnapshot(id);
  const outputPath = useConfigPath ? resolveConfiguredOutputPath() : undefined;
  if (format === "pdf") await exportPdf(id, snapshot.revision, outputPath);
  else if (format === "png") await exportPng(id, snapshot.revision, outputPath);
  else await exportSvg(id, snapshot.revision, outputPath);
}
