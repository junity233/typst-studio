import type { ApplyWorkspaceEditResult } from "vscode-languageserver-protocol";
import type { TextEdit } from "vscode-languageserver-types";
import type {
  WorkspaceEditPlan,
  PlannedModelEdit,
  PlannedDiskEdit,
  PlannedConfirmation,
} from "./workspaceEdit";

/**
 * The Monaco-free, store-free application layer for a planned `WorkspaceEdit`
 * (spec §12.2). The PURE planning logic lives in
 * [`planWorkspaceEdit`](./workspaceEdit.ts); this module contains the four
 * DEPENDENCY-INJECTED application seams that the production handler
 * ([`workspaceApplyEditHandler.ts`](./workspaceApplyEditHandler.ts)) composes
 * with the live registry / store / dialog / IPC. Keeping them here (with NO
 * Monaco / store / dialog imports) makes them unit-testable under jsdom — real
 * Monaco pulls widget CSS that jsdom can't run.
 *
 * The seams:
 *
 *   - [`applyModelEdits`](Self.applyModelEdits): apply open-doc LSP TextEdit[]
 *     to Monaco models (resolves URI → model via an injected registry).
 *   - [`confirmationMessage`](Self.confirmationMessage): pure presentational.
 *   - [`executeWorkspaceEditPlan`](Self.executeWorkspaceEditPlan): the
 *     orchestration (confirm → model → disk → result) with all I/O injected.
 *   - [`applyDiskEdits`](Self.applyDiskEdits): route resource ops + un-open-file
 *     text edits through an injected backend IPC surface.
 *
 * See [`workspaceApplyEditHandler.ts`](./workspaceApplyEditHandler.ts) for the
 * production wiring + the spec §12.2 scope/limitations discussion.
 */

/** A Monaco edit operation (1-indexed line/column, as `model.applyEdits` expects). */
export interface MonacoEditOp {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
}

/**
 * The minimal model surface [`applyModelEdits`](Self.applyModelEdits) needs.
 * Extracted as a named interface so the registry parameter type stays readable
 * and a unit test can supply a fake. `applyEdits` returns `void` to match real
 * Monaco's `ITextModel.applyEdits` (which discards the return for non-undo-stop
 * edits); we don't need the result. Only `entry.uri` (the canonical string) is
 * read — the model's own `uri` property is intentionally NOT in this interface
 * (real Monaco's is a `Uri` object, not a string, and we don't need it).
 */
export interface EditableModelEntry {
  model: {
    applyEdits: (ops: MonacoEditOp[]) => void;
  };
  uri: string;
}

/** The minimal registry surface [`applyModelEdits`](Self.applyModelEdits) needs. */
export interface ModelEditRegistry {
  resolveDocumentId: (uri: string) => string | null;
  getModel: (id: string) => EditableModelEntry | undefined;
}

/**
 * Apply a planned set of OPEN-DOC edits to the matching Monaco models. Returns
 * the URIs it could NOT apply (no open model at that URI) — the caller treats
 * those as a failure.
 *
 * Each model's edits go through ONE `model.applyEdits` call (a single atomic
 * operation = one undo step). The resulting content-change then flows through
 * the editor's normal onChange path (dirty + revision + backend forward) — we
 * do NOT bypass the dirty/revision flow (§12.2 "进入正常 dirty/revision 流程").
 *
 * LSP ranges are 0-indexed; Monaco is 1-indexed for both lines and columns, so
 * each TextEdit is converted here.
 */
export function applyModelEdits(
  modelEdits: PlannedModelEdit[],
  registry: ModelEditRegistry,
): string[] {
  const failed: string[] = [];
  for (const { uri, edits } of modelEdits) {
    const id = registry.resolveDocumentId(uri);
    if (id === null) {
      failed.push(uri);
      continue;
    }
    const entry = registry.getModel(id);
    if (entry === undefined) {
      failed.push(uri);
      continue;
    }
    const ops: MonacoEditOp[] = edits.map((e: TextEdit) => ({
      range: {
        startLineNumber: e.range.start.line + 1,
        startColumn: e.range.start.character + 1,
        endLineNumber: e.range.end.line + 1,
        endColumn: e.range.end.character + 1,
      },
      text: e.newText,
    }));
    entry.model.applyEdits(ops);
  }
  return failed;
}

/**
 * Confirmation dialog text for a planned overwrite. PURE (presentational) so a
 * test can pin the message shape without standing up the dialog store. Maps each
 * confirmation reason to a human-readable explanation.
 */
export function confirmationMessage(
  confirmations: PlannedConfirmation[],
): string {
  if (confirmations.length === 0) return "";
  const lines = confirmations.map((c) => {
    const why =
      c.reason === "delete-dirty"
        ? "deleting this file would discard unsaved edits"
        : c.reason === "rename-overwrite"
          ? "moving onto this file would overwrite its unsaved edits"
          : "this would overwrite its unsaved edits";
    return `  • ${c.uri} — ${why}`;
  });
  return `This workspace edit touches ${
    confirmations.length === 1 ? "a document" : `${confirmations.length} documents`
  } with unsaved changes:\n${lines.join("\n")}\n\nApply anyway?`;
}

/** A disk-side failure (URI + reason), collected by [`applyDiskEdits`](Self.applyDiskEdits). */
export interface DiskApplyFailure {
  uri: string;
  reason: string;
}

/**
 * The injected backend IPC surface for
 * [`applyDiskEdits`](Self.applyDiskEdits). Each method mirrors an existing
 * `lib/tauri.ts` IPC command. `applyTextEditsToDiskFile` is OPTIONAL: when
 * absent, an un-open-file text edit is reported as a failure (Phase D limitation
 * — see the module doc in [`workspaceApplyEditHandler.ts`](./workspaceApplyEditHandler.ts)).
 */
export interface DiskApplyIpc {
  createEntry?: (rel: string, kind: "file" | "directory") => Promise<void>;
  renameEntry?: (from: string, to: string) => Promise<unknown>;
  deleteEntry?: (rel: string) => Promise<unknown>;
  /** Apply LSP TextEdit[] to a not-open file (read → edit → atomic write). */
  applyTextEditsToDiskFile?: (uri: string, edits: TextEdit[]) => Promise<void>;
}

/**
 * Apply a planned set of DISK edits (un-open-file text edits + resource ops) via
 * the injected backend safe-file API. Returns the list of failures (each with a
 * reason); NEVER throws (a thrown IPC is captured as a failure so the request
 * handler can reply `{ applied: false }` rather than crashing).
 *
 * Resource ops (create/rename/delete) route to the matching IPC after converting
 * the absolute `file:` URIs to workspace-relative paths via the injected
 * `uriToRel`. A URI outside the workspace is a failure (the backend IPC only
 * operates on workspace-relative paths).
 *
 * Phase D scope: un-open-file TEXT edits require the OPTIONAL
 * `applyTextEditsToDiskFile` (a backend "read → edit → atomic write" command not
 * yet wired). When it's absent, such edits fail loudly rather than silently
 * dropping (the spec's "never silently corrupt" safety property).
 */
export async function applyDiskEdits(
  diskEdits: PlannedDiskEdit[],
  ipc: DiskApplyIpc,
  /** Convert an absolute file URI → workspace-relative path. Null if not in ws. */
  uriToRel: (uri: string) => string | null,
): Promise<DiskApplyFailure[]> {
  const failures: DiskApplyFailure[] = [];
  for (const op of diskEdits) {
    // Phase D: the LSP resource-op `options` (CreateFile.options.overwrite /
    // ignoreIfExists, RenameFile.options.overwrite / ignoreIfNotExists,
    // DeleteFile.options.recursive / ignoreIfNotExists) are NOT forwarded to
    // the backend IPC — the current create_entry/rename_entry/delete_entry
    // signatures take no such flags, so the backend's own dedup/conflict
    // handling applies. The confirmation gate above already catches the
    // dangerous cases (overwriting a dirty/conflicted doc); a future backend
    // extension can plumb the options through `DiskApplyIpc`.
    try {
      if (op.kind === "text") {
        if (ipc.applyTextEditsToDiskFile === undefined) {
          failures.push({
            uri: op.uri,
            reason: "applying text edits to a not-open file is not yet supported",
          });
          continue;
        }
        await ipc.applyTextEditsToDiskFile(op.uri, op.edits);
      } else if (op.kind === "create") {
        const rel = uriToRel(op.op.uri);
        if (rel === null) {
          failures.push({
            uri: op.op.uri,
            reason: "create target is outside the workspace",
          });
          continue;
        }
        await ipc.createEntry?.(rel, "file");
      } else if (op.kind === "rename") {
        const fromRel = uriToRel(op.op.oldUri);
        const toRel = uriToRel(op.op.newUri);
        if (fromRel === null || toRel === null) {
          failures.push({
            uri: op.op.oldUri,
            reason: "rename source or target is outside the workspace",
          });
          continue;
        }
        await ipc.renameEntry?.(fromRel, toRel);
      } else {
        // delete
        const rel = uriToRel(op.op.uri);
        if (rel === null) {
          failures.push({
            uri: op.op.uri,
            reason: "delete target is outside the workspace",
          });
          continue;
        }
        await ipc.deleteEntry?.(rel);
      }
    } catch (e) {
      failures.push({ uri: uriOf(op), reason: errorMessage(e) });
    }
  }
  return failures;
}

/** Best-effort URI extraction from a PlannedDiskEdit for failure reporting. */
function uriOf(op: PlannedDiskEdit): string {
  if (op.kind === "text") return op.uri;
  if (op.kind === "create") return op.op.uri;
  if (op.kind === "rename") return op.op.oldUri;
  return op.op.uri; // delete
}

/** Coerce a thrown value into a human-readable message. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Apply a planned `WorkspaceEdit` end-to-end, driving confirmation + model
 * application + disk application. This is the body of the `workspace/applyEdit`
 * request handler; it's exported (and parameterized over the dialog + IPC +
 * model-apply seams) so the request handler is a thin wrapper and the
 * orchestration is unit-testable.
 *
 * Returns `{ applied: false, failureReason }` on ANY failure (declined
 * confirmation, a model miss, or a disk failure) so tinymist knows the edit
 * didn't fully apply. The model edits that DID apply before a later failure are
 * NOT rolled back (Phase D scope; LSP allows partial application when the client
 * doesn't advertise transactional failure handling).
 *
 * Ordering (§12.2):
 *   1. confirmation gate — a declined overwrite leaves ALL docs untouched;
 *   2. model edits (the common, open-doc case);
 *   3. disk edits (resource ops + un-open-file text edits).
 */
export async function executeWorkspaceEditPlan(
  plan: WorkspaceEditPlan,
  deps: {
    /** Surface the confirmation dialog; resolves true on "apply anyway". */
    confirm: (message: string) => Promise<boolean>;
    /** Apply open-doc edits to Monaco models. Returns the URIs that failed. */
    applyModels: (modelEdits: PlannedModelEdit[]) => string[];
    /** Apply disk edits via the backend. Returns the failures. */
    applyDisk: (diskEdits: PlannedDiskEdit[]) => Promise<DiskApplyFailure[]>;
  },
): Promise<ApplyWorkspaceEditResult> {
  // §12.2: gate on confirmation FIRST — a declined overwrite leaves ALL docs
  // untouched (no partial application of the would-be-clobbered edits).
  if (plan.needsConfirmation.length > 0) {
    const accepted = await deps.confirm(confirmationMessage(plan.needsConfirmation));
    if (!accepted) {
      return { applied: false, failureReason: "user declined overwrite" };
    }
  }

  // Model edits first (the common case). A URI that doesn't resolve to an open
  // model is a failure — tinymist thought the doc was open but it isn't (race
  // with a tab close, etc.).
  const modelFailures = deps.applyModels(plan.applyToModel);
  if (modelFailures.length > 0) {
    return {
      applied: false,
      failureReason: `could not apply edits to open model(s): ${modelFailures.join(", ")}`,
    };
  }

  // Then disk edits (resource ops + un-open-file text edits).
  const diskFailures = await deps.applyDisk(plan.applyToDisk);
  if (diskFailures.length > 0) {
    const reasons = diskFailures.map((f) => `${f.uri} (${f.reason})`).join("; ");
    return {
      applied: false,
      failureReason: `disk edit(s) failed: ${reasons}`,
    };
  }

  return { applied: true };
}
