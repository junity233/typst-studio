import type { ApplyWorkspaceEditResult } from "vscode-languageserver-protocol";
import type { MonacoLanguageClient } from "monaco-languageclient";
import {
  ApplyWorkspaceEditRequest,
  type ApplyWorkspaceEditParams,
} from "vscode-languageserver-protocol";
import type { TextEdit } from "vscode-languageserver-types";
import { planWorkspaceEdit } from "./workspaceEdit";
import {
  applyModelEdits,
  applyDiskEdits,
  executeWorkspaceEditPlan,
  toEntryKindWire,
  type DiskApplyIpc,
} from "./workspaceEditApplier";
import { monacoModelRegistry } from "./monacoModelRegistry";
import { useDocumentsStore } from "../../store/documentsStore";
import { useDialogStore } from "../../store/dialogStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import {
  applyTextEditsToDiskFile,
  createEntry,
  deleteEntry,
  renameEntry,
} from "../../lib/tauri";
import { fileUriToWorkspaceRel } from "../../lib/workspacePath";
import i18n from "../../i18n";

/**
 * The production `workspace/applyEdit` request handler + its registration helper
 * (spec §12.2). The PURE planning logic lives in
 * [`planWorkspaceEdit`](./workspaceEdit.ts); the four dependency-injected
 * application seams live in [`workspaceEditApplier.ts`](./workspaceEditApplier.ts)
 * (Monaco-free, unit-tested). THIS module is the thin shell that wires those
 * seams to the LIVE registry / store / dialog / IPC and registers the handler on
 * the language client.
 *
 * ## Why override the default handler
 *
 * `vscode-languageclient` auto-registers `workspace/applyEdit` →
 * `handleApplyWorkspaceEdit`, which delegates to `vscode.workspace.applyEdit`
 * (the monaco-vscode-api bulk-edit service in the browser). That default routes
 * EVERYTHING through Monaco's in-memory VFS (the `RegisteredFileSystemProvider`
 * overlay): text edits to open models work, but un-open-file edits and resource
 * ops land in the in-memory VFS — NOT on real disk, NOT through the backend's
 * safe-file / DocumentService / watcher / recovery path. For a Typst project
 * that means an "extract to file" code action would create a phantom in-memory
 * file invisible to the file tree, the watcher, and tinymist's own disk-backed
 * resolver. We therefore override the default with this handler, which routes
 * un-open-file + resource-op edits to the backend.
 *
 * Registering a request handler via `client.onRequest(type, handler)` BEFORE
 * `client.start()` puts the handler in the client's `_pendingRequestHandlers`
 * map; at connection time the client registers its own `handleApplyWorkspaceEdit`
 * FIRST and then flushes the pending handlers (which OVERWRITE the auto-handler,
 * since the underlying JSON-RPC `requestHandlers` Map is last-writer-wins). So a
 * pre-start `onRequest(ApplyWorkspaceEditRequest.type, handler)` cleanly
 * replaces the default. Confirmed by reading
 * `vscode-languageclient/lib/common/client.js` (`onRequest` + the
 * `connection.onRequest(ApplyWorkspaceEditRequest.type, …)` line in the
 * connection hook).
 *
 * ## Disk path
 *
 * The DISK-application path covers un-open-file TEXT edits via the backend
 * `apply_text_edits_to_disk_file` command (read → splice → atomic write, with
 * LSP UTF-16 position decoding) and resource ops via the matching
 * `create_entry` / `rename_entry` / `delete_entry` IPC. See
 * [`applyDiskEdits`](./workspaceEditApplier.ts) for the failure semantics.
 *
 * ## Production wiring
 *
 * [`createProductionWorkspaceEditDeps`](Self.createProductionWorkspaceEditDeps)
 * builds the live deps from `lib/tauri.ts` + the workspace store;
 * `MonacoEditor` passes a `configureClient` hook to
 * `appLanguageClient.start()` that registers this handler on every FRESH
 * client (pre-start, so it overrides vscode-languageclient's default).
 */

/**
 * Collect the currently-open + dirty URI sets the planner needs, from the live
 * registry + store. The URIs are the canonical strings Monaco + tinymist both
 * see (the registry's `entry.uri`).
 */
function collectOpenAndDirtyUris(): {
  openUris: Set<string>;
  dirtyUris: Set<string>;
} {
  const openUris = new Set<string>();
  const dirtyUris = new Set<string>();
  const documents = useDocumentsStore.getState().documents;
  // The registry is the authority on which URIs are LIVE as Monaco models. We
  // walk every open doc, ask the registry for its entry, and if present add the
  // entry's canonical uri. (A doc that's in the store but not yet opened in the
  // registry — e.g. during the brief mount window — is treated as not-open here,
  // which is the safe classification: its edits would route to disk.)
  for (const doc of Object.values(documents)) {
    const entry = monacoModelRegistry.getModel(doc.id);
    if (entry !== undefined) {
      openUris.add(entry.uri);
      if (doc.dirty || doc.conflict !== "none") {
        dirtyUris.add(entry.uri);
      }
    }
  }
  return { openUris, dirtyUris };
}

/**
 * The injected backend IPC + URI→relpath surface the production handler needs.
 * [`createProductionWorkspaceEditDeps`](Self.createProductionWorkspaceEditDeps)
 * builds the live set from `lib/tauri.ts`'s `createEntry` / `renameEntry` /
 * `deleteEntry` / `applyTextEditsToDiskFile` and a `file:`-URI →
 * workspace-relative path converter rooted at `workspaceStore.rootPath`.
 */
export interface WorkspaceApplyEditDeps extends DiskApplyIpc {
  /** Convert an absolute file URI → workspace-relative path. Null if not in ws. */
  uriToRel: (uri: string) => string | null;
}

/**
 * Build the LIVE [`WorkspaceApplyEditDeps`](Self.WorkspaceApplyEditDeps) from
 * the real IPC wrappers + stores. All reads (`rootPath`) happen at CALL time so
 * a workspace switch between construction and use is honored per edit — the
 * uriToRel closure reads the store on every conversion.
 */
export function createProductionWorkspaceEditDeps(): WorkspaceApplyEditDeps {
  return {
    // The seam's IPC surface uses the literal `"directory"` from the LSP
    // resource-op layer (workspaceEdit.ts); the backend command takes the
    // entry-kind wire enum (`"dir"`).
    createEntry: (rel, kind) => createEntry(rel, toEntryKindWire(kind)),
    renameEntry: (from, to) => renameEntry(from, to),
    deleteEntry: (rel) => deleteEntry(rel),
    applyTextEditsToDiskFile: (uri, edits: TextEdit[]) =>
      applyTextEditsToDiskFile(uri, edits),
    uriToRel: (uri) =>
      fileUriToWorkspaceRel(useWorkspaceStore.getState().rootPath, uri),
  };
}

/**
 * The production `workspace/applyEdit` handler: builds the plan from the live
 * registry + store, then delegates to
 * [`executeWorkspaceEditPlan`](./workspaceEditApplier.ts). This is the function
 * registered on the language client (see
 * [`registerWorkspaceApplyEditHandler`](Self.registerWorkspaceApplyEditHandler)).
 */
export async function handleApplyWorkspaceEdit(
  params: ApplyWorkspaceEditParams,
  deps: WorkspaceApplyEditDeps,
): Promise<ApplyWorkspaceEditResult> {
  const { openUris, dirtyUris } = collectOpenAndDirtyUris();
  const plan = planWorkspaceEdit(params.edit, openUris, dirtyUris);
  return executeWorkspaceEditPlan(plan, {
    confirm: (message) =>
      useDialogStore
        .getState()
        .confirm({
          title: params.label ?? i18n.t("applyWorkspaceEdit.title", { ns: "dialog" }),
          message,
          confirmLabel: i18n.t("apply", { ns: "common" }),
          cancelLabel: i18n.t("cancel", { ns: "common" }),
        })
        .then((r) => r === "confirm"),
    applyModels: (modelEdits) =>
      applyModelEdits(modelEdits, monacoModelRegistry),
    applyDisk: (diskEdits) => applyDiskEdits(diskEdits, deps, deps.uriToRel),
  });
}

/**
 * Register the `workspace/applyEdit` handler on a language client, OVERRIDING
 * vscode-languageclient's default (which routes through the in-memory VFS — see
 * the module doc for why that's wrong for Typst). MUST be called BEFORE
 * `client.start()`: the handler then lands in the client's
 * `_pendingRequestHandlers` and is flushed at connection time AFTER the client's
 * own auto-handler registration, so it overwrites the default
 * (jsonrpc's `requestHandlers` Map is last-writer-wins).
 *
 * Returns a disposable that unregisters the handler (for tests / teardown).
 *
 * Wired from `MonacoEditor`'s `appLanguageClient.start({ configureClient })`
 * hook: the registration runs per FRESH client instance before `start()`, so
 * it reliably replaces vscode-languageclient's default on every
 * connect/reconnect.
 */
export function registerWorkspaceApplyEditHandler(
  client: MonacoLanguageClient,
  deps: WorkspaceApplyEditDeps,
): { dispose: () => void } {
  const disposable = client.onRequest(ApplyWorkspaceEditRequest.type, (params) =>
    handleApplyWorkspaceEdit(params, deps),
  );
  return { dispose: () => disposable.dispose() };
}

// Re-export the TextEdit type alias so callers wiring the OPTIONAL
// `applyTextEditsToDiskFile` IPC don't need a separate import.
export type { TextEdit };
