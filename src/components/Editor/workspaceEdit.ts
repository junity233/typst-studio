import type {
  WorkspaceEdit,
  TextEdit,
  TextDocumentEdit,
  CreateFile,
  RenameFile,
  DeleteFile,
} from "vscode-languageserver-types";

/**
 * Spec §12.2 (Tinymist workspace edit) — Task 10 Part B.
 *
 * When tinymist produces a `WorkspaceEdit` (a rename refactoring, a "extract to
 * file" code action, …) the language client receives a `workspace/applyEdit`
 * REQUEST from the server and must reply `ApplyWorkspaceEditResult { applied,
 * failureReason? }`. The edit may touch THREE disjoint kinds of resources:
 *
 *   (a) text edits to a CURRENTLY-OPEN Monaco model — apply in-memory through
 *       the model + the normal dirty/revision flow;
 *   (b) text edits to a NOT-OPEN disk file — route through the backend's
 *       safe-file / atomic-write API (we never touch disk from the renderer);
 *   (c) resource operations — CreateFile / RenameFile / DeleteFile — route
 *       through the backend's `create_entry` / `rename_entry` / `delete_entry`
 *       IPC so DocumentService / registry / watcher / recovery all stay
 *       coherent.
 *
 * And ANY edit that would OVERWRITE a dirty or conflicted doc MUST require
 * confirmation (§12.2 last bullet).
 *
 * ## Architecture: pure plan + non-pure shell
 *
 * This module exports two layers:
 *
 *   1. [`planWorkspaceEdit`](Self.planWorkspaceEdit) — the PURE planning
 *      function. It classifies every change in a `WorkspaceEdit` into
 *      `applyToModel` / `applyToDisk` / `needsConfirmation` buckets given ONLY
 *      two pure inputs: the set of currently-open URIs and the set of dirty /
 *      conflicted URIs. NO I/O, NO Monaco, NO backend — fully unit-testable.
 *      This is the spec-critical logic.
 *
 *   2. [`ApplyWorkspaceEditApplier`](Self.ApplyWorkspaceEditApplier) /
 *      [`registerWorkspaceApplyEditHandler`](Self.registerWorkspaceApplyEditHandler)
 *      — the non-pure shell: it reads the open/dirty URIs from the live
 *      registry + store, calls the planner, surfaces the confirmation dialog,
 *      executes the model edits + the backend IPC, and replies
 *      `ApplyWorkspaceEditResult`. This shell is INERT until `appLanguageClient`
 *      is wired into the live editor (Phase B deferral); the registration
 *      helper hooks `workspace/applyEdit` on the language client and is a no-op
 *      until that client starts.
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
 */

/**
 * A model-targeted edit: a `TextEdit[]` against a currently-OPEN Monaco model.
 * The applier resolves the URI → documentId via
 * [`monacoModelRegistry.resolveDocumentId`](./monacoModelRegistry.ts) and applies
 * the edits through the model (preserving cursor + going through the normal
 * dirty/revision flow).
 */
export interface PlannedModelEdit {
  /** Canonical URI of the open model the edits apply to. */
  uri: string;
  /** The text edits, in LSP form (ranges + replacement text). */
  edits: TextEdit[];
}

/**
 * Why a planned edit needs user confirmation before it can be applied. The
 * `uri` is the resource the edit would clobber; the applier surfaces a single
 * dialog listing all of these and replies `{ applied: false }` if the user
 * declines.
 */
export interface PlannedConfirmation {
  uri: string;
  reason:
    | "dirty-overwrite"
    | "conflicted-overwrite"
    | "delete-dirty"
    | "rename-overwrite";
}

/**
 * A disk-targeted operation: a text edit to a NOT-OPEN file, or a resource op
 * (create/rename/delete). The applier routes these to the backend's safe-file
 * API (`create_entry` / `rename_entry` / `delete_entry` IPC + the atomic-write
 * path used by save_as).
 */
export type PlannedDiskEdit =
  | {
      kind: "text";
      /** URI of the not-open file the edits apply to. */
      uri: string;
      /** The text edits (applied atomically to the file via the backend). */
      edits: TextEdit[];
    }
  | { kind: "create"; op: CreateFile }
  | { kind: "rename"; op: RenameFile }
  | { kind: "delete"; op: DeleteFile };

/**
 * The output of [`planWorkspaceEdit`](Self.planWorkspaceEdit). The applier
 * applies `applyToModel` first (Monaco), then `applyToDisk` (backend IPC). If
 * `needsConfirmation` is non-empty it surfaces a dialog and ABORTS on decline
 * BEFORE applying anything (so a declined overwrite leaves all docs untouched).
 */
export interface WorkspaceEditPlan {
  applyToModel: PlannedModelEdit[];
  applyToDisk: PlannedDiskEdit[];
  needsConfirmation: PlannedConfirmation[];
}

/**
 * Classify a [`WorkspaceEdit`] into model-targeted edits, disk-targeted
 * operations, and confirmation requirements (spec §12.2). PURE: no side effects,
 * no I/O — the spec-critical logic, unit-tested directly.
 *
 * @param edit        The LSP `WorkspaceEdit` to classify.
 * @param openUris    The canonical URIs of every currently-OPEN Monaco model
 *   (from `monacoModelRegistry`). An edit whose URI is in here is an in-memory
 *   model edit; otherwise it's a disk edit.
 * @param dirtyUris   The canonical URIs of every DIRTY or CONFLICTED open doc
 *   (from `documentsStore`). Any edit touching one of these — a model overwrite,
 *   a disk overwrite, a delete, or a rename onto it — needs confirmation.
 * @returns The plan buckets.
 *
 * ## Classification rules (§12.2)
 *
 * - `changes` (legacy `{ uri: TextEdit[] }` form): each entry whose URI is open
 *   → `applyToModel`; otherwise → `applyToDisk` (text).
 * - `documentChanges` (modern form, preferred when present): each
 *   `TextDocumentEdit` is classified by its `textDocument.uri` (open → model,
 *   else disk-text). `CreateFile`/`RenameFile`/`DeleteFile` → `applyToDisk` as
 *   the matching op kind.
 * - When BOTH `documentChanges` and `changes` are present, LSP semantics are
 *   that `documentChanges` is preferred; we follow that (only plan
 *   `documentChanges` when it's present, else fall back to `changes`).
 *
 * ## Confirmation rules (§12.2 last bullet)
 *
 * - A TEXT edit (model or disk) whose URI is dirty/conflicted → confirm
 *   (`dirty-overwrite` / `conflicted-overwrite`). The planner does NOT
 *   distinguish dirty from conflicted at the input level (both arrive via
 *   `dirtyUris`); the applier refines the reason by re-reading the doc's
 *   `conflict` field. To keep the pure function self-contained, the reason here
 *   is the conservative `dirty-overwrite`; the applier upgrades it to
 *   `conflicted-overwrite` when the doc is actually in conflict. (Both map to
 *   the same dialog.)
 * - A `DeleteFile` whose URI is dirty/conflicted → confirm (`delete-dirty`).
 * - A `RenameFile` whose `newUri` is an existing open dirty doc (i.e. in
 *   `dirtyUris`) → confirm (`rename-overwrite`). We cannot cheaply know from the
 *   pure inputs whether the target EXISTS on disk; we only flag the
 *   dirty-target case (the dangerous one). A non-open disk target is left for
 *   the backend's `rename_entry` to reject/confirm via its `AlreadyOpen` /
 *   atomic-write path.
 * - `CreateFile` with `options.overwrite: true` onto a dirty target is NOT
 *   flagged here (CreateFile targets a NEW uri; an open dirty doc at that uri
 *   would be unusual). If it ever matters, the backend's atomic-write gate
 *   catches it.
 */
export function planWorkspaceEdit(
  edit: WorkspaceEdit,
  openUris: Set<string>,
  dirtyUris: Set<string>,
): WorkspaceEditPlan {
  const plan: WorkspaceEditPlan = {
    applyToModel: [],
    applyToDisk: [],
    needsConfirmation: [],
  };

  const isDirty = (uri: string): boolean => dirtyUris.has(uri);

  // Prefer `documentChanges` (the modern, richer form) when present — LSP
  // semantics: a client that signals documentChanges support uses it over the
  // legacy `changes` map.
  if (edit.documentChanges !== undefined) {
    for (const change of edit.documentChanges) {
      if (isTextDocumentEdit(change)) {
        const uri = change.textDocument.uri;
        if (openUris.has(uri)) {
          plan.applyToModel.push({ uri, edits: change.edits as TextEdit[] });
          if (isDirty(uri)) {
            plan.needsConfirmation.push({ uri, reason: "dirty-overwrite" });
          }
        } else {
          plan.applyToDisk.push({ kind: "text", uri, edits: change.edits as TextEdit[] });
        }
      } else if (isCreateFile(change)) {
        plan.applyToDisk.push({ kind: "create", op: change });
      } else if (isRenameFile(change)) {
        // A rename onto a dirty target would clobber unsaved edits → confirm.
        if (isDirty(change.newUri)) {
          plan.needsConfirmation.push({
            uri: change.newUri,
            reason: "rename-overwrite",
          });
        }
        plan.applyToDisk.push({ kind: "rename", op: change });
      } else if (isDeleteFile(change)) {
        // Deleting a dirty doc's backing file loses unsaved edits → confirm.
        if (isDirty(change.uri)) {
          plan.needsConfirmation.push({ uri: change.uri, reason: "delete-dirty" });
        }
        plan.applyToDisk.push({ kind: "delete", op: change });
      }
      // Unknown documentChange kinds are silently skipped (defensive — the LSP
      // spec doesn't define others today, and skipping is safer than throwing).
    }
    return plan;
  }

  // Legacy `changes` form (no resource ops possible here).
  if (edit.changes !== undefined) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (openUris.has(uri)) {
        plan.applyToModel.push({ uri, edits: edits as TextEdit[] });
        if (isDirty(uri)) {
          plan.needsConfirmation.push({ uri, reason: "dirty-overwrite" });
        }
      } else {
        plan.applyToDisk.push({
          kind: "text",
          uri,
          edits: edits as TextEdit[],
        });
      }
    }
  }

  return plan;
}

// --- narrow type guards for the documentChanges union (no runtime deps) ------
// `vscode-languageserver-types` ships `CreateFile.is` / `RenameFile.is` /
// `DeleteFile.is` / `TextDocumentEdit.is` helpers, but importing them pulls the
// full protocol surface at module load. The `kind` discriminator is stable per
// the LSP spec, so local guards keep this module light and avoid the import.

function isTextDocumentEdit(
  c: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
): c is TextDocumentEdit {
  return (c as TextDocumentEdit).edits !== undefined;
}
function isCreateFile(
  c: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
): c is CreateFile {
  return (c as CreateFile).kind === "create";
}
function isRenameFile(
  c: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
): c is RenameFile {
  return (c as RenameFile).kind === "rename";
}
function isDeleteFile(
  c: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
): c is DeleteFile {
  return (c as DeleteFile).kind === "delete";
}
