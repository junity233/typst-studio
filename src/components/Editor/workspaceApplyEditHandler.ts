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
  type DiskApplyIpc,
} from "./workspaceEditApplier";
import { monacoModelRegistry } from "./monacoModelRegistry";
import { useDocumentsStore } from "../../store/documentsStore";
import { useDialogStore } from "../../store/dialogStore";
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
 * ## Phase D scope (conservative)
 *
 * The MODEL-application path (open docs) is fully implemented: it resolves each
 * URI → documentId via the registry, applies the LSP `TextEdit[]` to the live
 * Monaco model as a single `applyEdits` op, and the resulting content-change
 * flows through the editor's normal onChange → `updateContent` + backend-forward
 * path (dirty + revision bump). This is the common case for a rename refactoring
 * or a "wrap in …" code action on an open doc.
 *
 * The DISK-application path is INTENTIONALLY conservative: for an un-open-file
 * text edit, we don't have the file's content in memory, so applying partial
 * `TextEdit[]` requires a backend round-trip (read → apply edits → atomic
 * write). For Phase D the handler reports such edits as failures (see
 * [`applyDiskEdits`](./workspaceEditApplier.ts)) rather than corrupting state.
 * Resource ops (create/rename/delete) route to the matching `create_entry` /
 * `rename_entry` / `delete_entry` IPC. A future task can harden the un-open-file
 * text-edit path (read+edit+atomic-write) once the backend exposes a single
 * "apply text edits to a not-open file" command; until then the model path
 * carries the real value and the disk path is best-effort.
 *
 * ## Inert until rewire
 *
 * This handler is registered on `appLanguageClient`'s `MonacoLanguageClient`
 * BEFORE `client.start()` (see
 * [`registerWorkspaceApplyEditHandler`](Self.registerWorkspaceApplyEditHandler)),
 * so it lands in the client's `_pendingRequestHandlers` and overwrites
 * vscode-languageclient's auto-registered default at connection time. But
 * `appLanguageClient.start()` is NOT called from the UI yet (Phase B deferral —
 * the wrapper-driven client still drives the live session). So this handler is
 * INERT until the rewire task swaps MonacoEditor to the singleton. The wrapper's
 * OWN default `workspace/applyEdit` handling continues to serve the live session
 * in the meantime.
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
 * The rewire task constructs this from `lib/tauri.ts`'s `createEntry` /
 * `renameEntry` / `deleteEntry` and a `file:`-URI → workspace-relative path
 * converter rooted at `workspaceStore.rootPath`. `applyTextEditsToDiskFile` is
 * OPTIONAL (Phase D limitation — see the module doc).
 */
export interface WorkspaceApplyEditDeps extends DiskApplyIpc {
  /** Convert an absolute file URI → workspace-relative path. Null if not in ws. */
  uriToRel: (uri: string) => string | null;
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
 * INERT until the rewire: `appLanguageClient.start()` is not called from the UI
 * yet, so this registration only takes effect once a later task rewires
 * MonacoEditor to drive the singleton client.
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
